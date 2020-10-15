/*

1. Retrive latest defect list from Google Sheets
2. Build index
3. Deploy JSON to Google Cloud Storage

*/

require("isomorphic-fetch");
const zlib = require('zlib');

const { GoogleSpreadsheet } = require('google-spreadsheet');
const AWS = require('aws-sdk');

const { DateTime } = require("luxon");

const { validateEnvVars, parseBoolean, asyncForEach, asyncMap, sendSlackNotification, sendErrorNotification, getCloudWatchLogDeeplink, sleep } = require("./global.js");

const DEVELOPMENT_ENV_FILE_PATH = "../.env"

const pipe = (...fns) => x => fns.reduce((y, f) => f(y), x);



const RUNNING_IN_DEVELOPMENT_MODE = !process.env.AWS_LAMBDA_LOG_GROUP_NAME;

let fs;

// If we're running outside of AWS Lambda, load 
// env vars from a .env file in project root
if(RUNNING_IN_DEVELOPMENT_MODE) {
  fs = require('fs');
  const path = require('path');

  const resolveFilePath = filepath => path.resolve(process.cwd(), filepath)

  const readJSONFile = pipe(
    resolveFilePath,
    fs.readFileSync,
    buffer => buffer.toString()
  )

  function loadEnvVars() {
    const envVars = readJSONFile(DEVELOPMENT_ENV_FILE_PATH).
      split("\n").
      map(line => line.split("="));

    envVars.forEach(([key, value])=>{
      process.env[key] = value;
    });
  }

  loadEnvVars();
}


validateEnvVars([
  "GOOGLE_API_CLIENT_EMAIL",
  "GOOGLE_API_PRIVATE_KEY",
  "GOOGLE_SHEETS_MEETING_LIST_SPREADSHEET_ID",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "CLOUDFRONT_DISTRIBUTION_ID",
  "AWS_S3_BUCKET",
  "AWS_S3_REGION",
  "SLACK_WEBHOOK_URL"
])


const {
  GOOGLE_API_CLIENT_EMAIL,
  GOOGLE_API_PRIVATE_KEY,
  GOOGLE_SHEETS_MEETING_LIST_SPREADSHEET_ID,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY
} = process.env;

const AWS_CREDS = RUNNING_IN_DEVELOPMENT_MODE ? 
{
  accessKeyId: AWS_ACCESS_KEY_ID,
  secretAccessKey: AWS_SECRET_ACCESS_KEY
} : 
undefined; // In production, the AWS SDK will automatically capture credentials from the Lambda environment

// Runtime

const doc = new GoogleSpreadsheet(GOOGLE_SHEETS_MEETING_LIST_SPREADSHEET_ID);

var s3 = new AWS.S3(AWS_CREDS);

const loginPromise = doc.useServiceAccountAuth({
  client_email: GOOGLE_API_CLIENT_EMAIL,
  private_key: GOOGLE_API_PRIVATE_KEY.replace(/\\n/g, "\n")
});

async function getDoc() {
  await loginPromise;
  await doc.loadInfo();
  return doc;
}

function uploadJsonFile({bucket, folderName = "", fileName, fileContents}) {
  return new Promise(function(resolve, reject) {
      s3.upload({
          Bucket: bucket,
          Key: `${folderName}/${fileName}`,
          Body: zlib.gzipSync(JSON.stringify(fileContents))
      }).
      promise().
      then(resolve, reject);
  });
}

const COLUNM_COUNT = 11;

const map = (i, fn) => Array.from({length: i}).map((_, index) => fn(index));

const getRowContent = sheet => rowNumber => map(COLUNM_COUNT, i => sheet.getCell(rowNumber, i)._rawData.formattedValue);

const VALID_ZOOM_PASSWORD_REGEX=/[a-z0-9]/ig
const MATCH_AA = /\s+aa\s+|^aa\s+/ig;
const MATCH_OPEN_MEETING = /\s+open\s+|^open\s/ig;
const MATCH_WOMEN_ONLY= /women|woman|female/ig
const MATCH_MEN_ONLY=/men|man|male/ig

const formatMeetingInfo = ({dayOfWeekEST, startTimeEST, meetingName, zoomMeetingId, zoomMeetingPassword, zoomJoinUrl, contactInfo, unknownCol}) => {
  let gender;
  if(MATCH_WOMEN_ONLY.test(meetingName)) {
    gender = "WOMEN_ONLY";
  } else if(MATCH_MEN_ONLY.test(meetingName)) {
    gender = "MEN_ONLY"
  } else {
    gender = "ALL"
  }
  

  return {
    name: meetingName,
    nextOccurrence: getNextOccurance({dayOfWeekEST, startTimeEST}),
    connectionDetails: {
      platform: 'zoom',
      mustContactForConnectionInfo: !VALID_ZOOM_PASSWORD_REGEX.test(zoomMeetingPassword),
      meetingId: zoomMeetingId,
      password: zoomMeetingPassword,
      joinUrl: zoomJoinUrl
    },
    contactInfo: contactInfo,
    notes: "",
    participantCount: "",
    metadata: {
      hostLocation: "",
      localTimezoneOffset: undefined, 
      language: "en",
      fellowship: MATCH_AA.test(meetingName) ? "aa" : "sa",
      restrictions: {
        openMeeting: MATCH_OPEN_MEETING.test(meetingName),
        gender,
      }
    }
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


    const meetingCount = sheet.rowCount - ROWS_OCCUPIED_BY_HEADER;
    const meetingList = map(meetingCount, retrieveFormattedMeetingFromSheet(sheet)).
      filter(item => item !== undefined).
      sort(sortMeetingFn);

    console.log(`Generated schedule (${meetingList.length} total meetings)`);
    

    const twentyFourHoursFromNow = DateTime.local().plus({hours: 24}).toUTC().toISO();
    const sixHoursFromNow = DateTime.local().plus({hours: 6}).toUTC().toISO();

    const next7Days = {
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

 
    if(process.env.RUN_LOCAL) {
      console.log(`[dev] Writing files to local disk`);
      fs.writeFileSync("meetingsNext7Days.json", JSON.stringify(next7Days)); // Avg. 70 KB (5 KB GZIP)
      fs.writeFileSync("meetingsNext24Hours.json", JSON.stringify(next24Hours)); // Avg 11 KB (1.9 KB GZIP)
      console.log(`✅ Done`);
    }


    console.log(`🌀 Uploading files...`);
    await uploadJsonFile({
      bucket: process.env.AWS_S3_BUCKET,
      folderName: "sa",
      fileName: "next24Hours.json.gzip",
      fileContents: next24Hours
    })

    await uploadJsonFile({
      bucket: process.env.AWS_S3_BUCKET,
      folderName: "sa",
      fileName: "next7Days.json.gzip",
      fileContents: next7Days
    })
    console.log(`✅ Done`);

    // Invalidate CDN


    // Note - using a timestamp as a CallerReference defeats the Cloudfront 
    // anti-duplicate request preventer. As this will be called infrequently,
    // but will occasionally be called several times in rapid succession, it seems necessary to let every invalidation go through.
    // See https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_CreateInvalidation.html#API_CreateInvalidation_RequestSyntax
    const invalidationUniqueId = new Date().getTime().toString();

    var options = {
      DistributionId: process.env.CLOUDFRONT_DISTRIBUTION_ID,
      InvalidationBatch: { 
        CallerReference: invalidationUniqueId,
        Paths: {
          Quantity: 2,
          Items: [
             "/sa/next24Hours.json",
             "/sa/next7Days.json",
          ]
        }
      }
    };

    console.log("🌀 Invalidating CDN...");

    const AWS_CREDS = RUNNING_IN_DEVELOPMENT_MODE ? 
      {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY
      } : 
      undefined;

    await new AWS.CloudFront(AWS_CREDS).createInvalidation(options).promise();

    console.log("✅ Invalidated");

    console.log(`✅ Success!`);
    await sendSlackNotification("✅ NextMeeting schedules regenerated")
  } catch (err) {
    console.error(err);
    await sendSlackNotification(`❗️ Error! ${err} ${JSON.stringify(err)}`);
    return { statusCode: 500, body: err.toString() }
  }
}

// Dev only
if(RUNNING_IN_DEVELOPMENT_MODE) {
  exports.handler();
}
