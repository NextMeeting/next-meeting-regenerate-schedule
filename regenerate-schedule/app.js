/*

1. Retrive latest defect list from Google Sheets
2. Build index
3. Deploy JSON to Google Cloud Storage

*/


const { GoogleSpreadsheet } = require('google-spreadsheet');
const AWS = require('aws-sdk');

const { DateTime } = require("luxon");
const { RRule, RRuleSet, rrulestr } = require('rrule');


const { validateEnvVars, parseBoolean, asyncForEach, asyncMap, sendSlackNotification, sendErrorNotification, getCloudWatchLogDeeplink, sleep } = require("./global.js");


// Local only

const fs = require('fs');
const path = require('path');
const { lookup } = require('dns');

const pipe = (...fns) => x => fns.reduce((y, f) => f(y), x);
const resolveFilePath = filepath => path.resolve(process.cwd(), filepath)

const readJSONFile = pipe(
  resolveFilePath,
  fs.readFileSync,
  buffer => buffer.toString()
)

function loadEnvVars() {
  const envVars = readJSONFile("../.env").
    split("\n").
    map(line => line.split("="));

  envVars.forEach(([key, value])=>{
    process.env[key] = value;
  });
}

loadEnvVars();

// end local only




validateEnvVars([
  "GOOGLE_API_CLIENT_EMAIL",
  "GOOGLE_API_PRIVATE_KEY",
  "GOOGLE_SHEETS_MEETING_LIST_SPREADSHEET_ID",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY"
])


const {
  GOOGLE_API_CLIENT_EMAIL,
  GOOGLE_API_PRIVATE_KEY,
  GOOGLE_SHEETS_MEETING_LIST_SPREADSHEET_ID,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY
} = process.env;

const OUTPUT_FILE_NAME = "meetings.json";

// Runtime

const doc = new GoogleSpreadsheet(GOOGLE_SHEETS_MEETING_LIST_SPREADSHEET_ID);

const loginPromise = doc.useServiceAccountAuth({
  client_email: GOOGLE_API_CLIENT_EMAIL,
  private_key: GOOGLE_API_PRIVATE_KEY.replace(/\\n/g, "\n")
});

async function getDoc() {
  await loginPromise;
  await doc.loadInfo();
  return doc;
}


async function uploadFile({bucket, fileName, fileContents}) {
  return storage.
    bucket(bucket).
    file(fileName).
    save(fileContents)
}

var s3 = new AWS.S3({
  accessKeyId: AWS_ACCESS_KEY_ID,
  secretAccessKey: AWS_SECRET_ACCESS_KEY
});


function uploadFile({bucket, fileName, fileContents}) {
  return new Promise(function(resolve, reject) {
      fileStream.once('error', reject);
      s3.upload({
          Bucket: bucketName,
          Key: fileName,
          Body: fileContents
      }).
      promise().
      then(resolve, reject);
  });
}

const COLUNM_COUNT = 11;

const map = (i, fn) => Array.from({length: i}).map((_, index) => fn(index));


const getRowContent = sheet => rowNumber => map(COLUNM_COUNT, i => sheet.getCell(rowNumber, i)._rawData.formattedValue);
const getHeaderColumnNames = sheet => getRowContent(sheet, 2);

const COLUMN_JSON_KEYS = ["dayOfWeekEST", "startTimeEST", "startTimePST", "startTimeUK", "startTimeIndia", "meetingName", "zoomMeetingId", "zoomMeetingPassword", "zoomJoinUrl", "contactInfo", "unknownCol"]; 
const rowToJson = cells => Object.fromEntries(cells.map((content, i) => [COLUMN_JSON_KEYS[i], content]))

const LUXON_DAYS_OF_WEEK = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
}


const dayOfWeekStringToLuxonWeekdayNumber = str => {
  if(!str) throw TypeError(`str must be defined. Got: \`${str}\``);
  const result = LUXON_DAYS_OF_WEEK[str.toLowerCase()];
  if(!result) throw TypeError(`Unable to find day of week constant for string \`${str}\``);
  return result;
}

const WHITESPACE_REGEX = /\s/ig;
const MATCH_PM_REGEX = /pm/ig;
const PM_HOURS_TO_ADD = 12;


/*
  BUGGY!
  The Am/Pm code isn't quite right yet, and gets easily confused
*/


// From https://gist.github.com/apolopena/ad4af8bb58e2b1f18b1e0bb78143ebdc
function convert12HourTimeTo24HourTime(s) {
  if(s.split(":")[0].length == 1) s = "0" + s; // Pad single-digit hours to simplify the slicing code
  const ampm = s.slice(-2);
  const hours = Number(s.slice(0, 2));
  let time = s.slice(0, -2);
  if (ampm === 'AM') {
      if (hours === 12) { // 12am edge-case
          return  time.replace(s.slice(0, 2), '00');
      }
      return time;
  } else if (ampm === 'PM') {
      if (hours !== 12) {
          return time.replace(s.slice(0, 2), String(hours + 12));
      } 
      return time; // 12pm edge-case
  }
  return 'Error: AM/PM format is not valid';
}

const parseHourAndMinute = str => {
  if(!str) throw TypeError(`str must be defined. Got: \`${str}\``);
  const convertedTo24HourTime = convert12HourTimeTo24HourTime(str);
  const [stringHour, stringMinute] = convertedTo24HourTime.split(":");
  return {
    hour: parseInt(stringHour),
    minute: parseInt(stringMinute)
  }
}

function getNextOccurance({dayOfWeekEST, startTimeEST}) {
  const {hour, minute} = parseHourAndMinute(startTimeEST);
  const luxonDate = DateTime.fromObject({
    zone: "America/New_York",
    weekday: dayOfWeekStringToLuxonWeekdayNumber(dayOfWeekEST),
    hour,
    minute
  }).toUTC();
  const luxonDateAsISO = luxonDate.toISO();
  if(luxonDateAsISO === null) console.error(`❗️ null date! Info: ${dayOfWeekEST} ${startTimeEST}`);
  if(luxonDateAsISO < new Date().toISOString()) { // Only generate meetings in the future
    return luxonDate.plus({weeks: 1}).toISO();
  }
  return luxonDateAsISO;
}

const formatMeetingInfo = ({dayOfWeekEST, startTimeEST, meetingName, zoomMeetingId, zoomMeetingPassword, zoomJoinUrl, contactInfo, unknownCol}) => {
  return {
    name: meetingName,
    nextOccurrence: getNextOccurance({dayOfWeekEST, startTimeEST}),
    connectionDetails: {
      platform: 'zoom',
      meetingId: zoomMeetingId,
      password: zoomMeetingPassword,
      quickJoinUrl: zoomJoinUrl
    },
    contactInfo: contactInfo,
    participants: "",
    metadata: {
      hostLocation: "",
      language: "en",
      fellowship: "",
      restrictions: {
        openToPublic: false,
        gender: "ALL"
      }
    }
  }
}

const ROWS_OCCUPIED_BY_HEADER = 2;

const retrieveFormattedMeetingFromSheet = sheet => i => {
  if(i <= ROWS_OCCUPIED_BY_HEADER) return;
  return pipe(
    getRowContent(sheet),
    rowToJson,
    formatMeetingInfo
  )(i)
}

function sortMeetingFn({nextOccurrence: a}, {nextOccurrence: b}) {
  if(a < b) return -1;
  if(a > b) return 1;
  return 0;
}


exports.handler = async (event, context) => {

  try {

    const doc = await getDoc();
    const sheet = doc.sheetsByIndex[0];
    console.log(sheet.title);

    console.log("Loading sheet data...");
    await sheet.loadCells();
    console.log("Loaded");

    console.log(`${sheet.rowCount} rows`);

    const meetingCount = sheet.rowCount - ROWS_OCCUPIED_BY_HEADER;
    const meetingList = map(meetingCount, retrieveFormattedMeetingFromSheet(sheet)).
      filter(item => item !== undefined).
      sort(sortMeetingFn);

    meetingList.forEach(meeting => {
      console.log(`${meeting.nextOccurrence ? new Date(meeting.nextOccurrence).toString() : null}: ${meeting.name}`)
    });
    

    const currentTime = new Date().toISOString();
    const twentyFourHoursFromNow = DateTime.local().plus({hours: 24}).toUTC().toISO();
    const sixHoursFromNow = DateTime.local().plus({hours: 6}).toUTC().toISO();

    const fullWeekSchedule = {
      metadata: {
        scheduleType: "fullWeek",
        generatedAt: new Date().toISOString(),
      },
      meetings: meetingList
    }

    const next24Hours = {
      metadata: {
        scheduleType: "next24Hours",
        generatedAt: new Date().toISOString(),
      },
      meetings: meetingList.filter((({nextOccurrence}) => nextOccurrence < twentyFourHoursFromNow))
    }

    const nextSixHours = {
      metadata: {
        scheduleType: "nextSixHours",
        generatedAt: new Date().toISOString(),
      },
      meetings: meetingList.filter((({nextOccurrence}) => nextOccurrence < sixHoursFromNow))
    }

    fs.writeFileSync("meetingsNext7Days.json", JSON.stringify(fullWeekSchedule));
    fs.writeFileSync("meetingsNext24Hours.json", JSON.stringify(next24Hours));
    fs.writeFileSync("meetingsNext6Hours.json", JSON.stringify(nextSixHours));

    // console.log("Uploading...");
    // await uploadFile({
    //   bucket: CLOUD_STORAGE_PUBLIC_BUCKET_ID,
    //   fileName: PREBUILT_INDEX_FILE_NAME,
    //   //fileContents: serialized
    // });

  } catch (err) {
    console.error(err);
    
    return { statusCode: 500, body: err.toString() }
  }
}

exports.handler();
