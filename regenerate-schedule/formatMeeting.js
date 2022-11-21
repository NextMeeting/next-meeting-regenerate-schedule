// Imports

const Honeybadger = require('@honeybadger-io/js')

const { DateTime } = require("luxon");
const extractEmail = require('extract-email-address').default;

const { validateEnvVars, parseBoolean, asyncForEach, asyncMap, sendSlackNotification, sendErrorNotification, getCloudWatchLogDeeplink, sleep, loadEnvVars, readFile, resolveFilePath, pipe, map } = require("./global.js");


// Consts

const ROWS_OCCUPIED_BY_HEADER = 2;
const ROWS_TO_IGNORE_FROM_END = 2;
const COLUNM_COUNT = 11;

const VALID_ZOOM_ID_REGEX=/[0-9]{3}/ig
const VALID_ZOOM_PASSWORD_REGEX=/[a-z0-9]/ig
const HAS_ALPHABET = /[a-z]/ig
const MATCH_AA = /\s+aa\s+|^aa\s+/ig;
const MATCH_OPEN_MEETING = /\s+open\s+|^open\s/ig;
const MATCH_WOMEN_ONLY= /women|woman|female/ig
const MATCH_MEN_ONLY=/men|man|male/ig
const MATCHES_DIGITS_REGEX = /\d/

// Platform matchers
const SKYPE_JOIN_LINK_REGEX = /http.:\/\/join.skype./gim
const ZOOM_JOIN_LINK_REGEX = /http.:\/\/.*.zoom.us/gim
const PHONE_NUMBER_LINK_REGEX = /tel:/gim
const EMAIL_LINK_REGEX = /mailto:/gim

// Main

const retrieveFormattedMeetingFromSheet = sheet => i => {
	if(i <= ROWS_OCCUPIED_BY_HEADER) return;
	return pipe(
		// data => {console.log(data); return data},
		getRowContent(sheet),
		rowToJson,
		// data => {console.log(data); return data},
		formatMeetingInfo
	)(i)
}


// Helpers

function determinePlatform({ meetingId, meetingPassword, joinUrl }) {
	if(!joinUrl) return 'unknown';
	if(joinUrl.includes('mailto:')) return 'email';
	if(joinUrl.includes('.zoom.us/')) return 'zoom';
  if(SKYPE_JOIN_LINK_REGEX.test(joinUrl)) return 'skype';
	if(joinUrl.includes('tel:')) return 'phone-number';
	// console.log(`"${joinUrl}"`)
  return 'unknown';
}

const formatMeetingInfo = ({dayOfWeekEST, startTimeEST, meetingName, zoomMeetingId, zoomMeetingPassword, zoomJoinUrl, contactInfo, unknownCol, notes = ''}) => {
	try {
		// console.log(`Formatting ${dayOfWeekEST} ${startTimeEST} ${meetingName}`);
		if(startTimeEST === undefined) {
			console.error(`❗️ meetingName: ${meetingName} No startTimeEST! Skipping\nDay: ${dayOfWeekEST} startTimeEST:${startTimeEST} `);
			return;
		}
		if(!containsNumbers(startTimeEST)) {
			console.error(`❗️ meetingName: ${meetingName} startTimeEST has no numbers! Skipping.\nDay: ${dayOfWeekEST} startTimeEST: ${startTimeEST} `);
			return;
		}
		
		if(zoomMeetingId === undefined && zoomMeetingPassword === undefined && zoomJoinUrl === undefined) {
			return;
		}
	
		let gender;
		if(MATCH_WOMEN_ONLY.test(meetingName)) {
			gender = "WOMEN_ONLY";
		} else if(MATCH_MEN_ONLY.test(meetingName)) {
			gender = "MEN_ONLY"
		} else {
			gender = "ALL"
		}
		
	
		const isValidZoomId = !HAS_ALPHABET.test(zoomMeetingId);
		//console.log(`${isValidZoomId ? "ℹ️" : "❌"} Valid Zoom regex: "${zoomMeetingId}" -> ${isValidZoomId}`);
	
  	const platform = determinePlatform({
    	meetingId: zoomMeetingId,
    	meetingPassword:zoomMeetingPassword,
    	joinUrl: zoomJoinUrl?.trim()
  	})
		
		const feedbackEmail = extractEmail(contactInfo || '')?.[0];
	
		//console.log(meetingName)
		return {
			name: meetingName || "<Untitled Meeting>",
			nextOccurrence: getNextOccurance({dayOfWeekEST, startTimeEST}),
			connectionDetails: {
				platform,
				mustContactForConnectionInfo: !zoomJoinUrl,
				meetingId: zoomMeetingId,
				password: zoomMeetingPassword,
				joinUrl: zoomJoinUrl
			},
			contactInfo: contactInfo,
			feedbackEmail: feedbackEmail?.email,
			notes,
			participantCount: "",
			durationMinutes: 60,
			metadata: {
				hostLocation: "",
				localTimezoneOffset: undefined, 
				language: "en",
				restrictions: {
					openMeeting: MATCH_OPEN_MEETING.test(meetingName),
					gender,
				}
			}
		}
	} catch(e) {
		console.error('❗ Error in meeting definition:');
		console.error(e);
		Honeybadger.notifyAsync(e);
		console.error('⏩ Skipping.')
	}
}


const ALLOW_ALREADY_STARTED_MEETINGS_THRESHOLD = {
	hours: 1, 
	minutes: 30
}

function getNextOccurance({dayOfWeekEST, startTimeEST}) {
	const { hour, minute } = parseHourAndMinute(startTimeEST);
	const luxonDate = DateTime.fromObject({
		zone: "America/New_York",
		weekday: dayOfWeekStringToLuxonWeekdayNumber(dayOfWeekEST),
		hour,
		minute
	}).toUTC();
	const luxonDateAsISO = luxonDate.toISO();
	if(luxonDateAsISO === null) console.error(`❗️ null date! Info: ${dayOfWeekEST} ${startTimeEST}`);

	const meetingAlreadyStartedAllowThreshold = DateTime.local().minus(ALLOW_ALREADY_STARTED_MEETINGS_THRESHOLD).toUTC().toISO();

	if(luxonDateAsISO < meetingAlreadyStartedAllowThreshold) { // Only generate meetings in the future
		return luxonDate.plus({weeks: 1}).toISO();
	}

	return luxonDateAsISO;
}


const COLUMN_JSON_KEYS = ["dayOfWeekEST", "startTimeEST", "meetingName", "zoomMeetingId", "zoomMeetingPassword", "zoomJoinUrl", "contactInfo", "notes"]; 
const rowToJson = cells => Object.fromEntries(cells.map((content, i) => [COLUMN_JSON_KEYS[i], content]))

const LUXON_DAYS_OF_WEEK = {
	monday: 1,
	tuesday: 2,
	wednesday: 3,
	thursday: 4,
	friday: 5,
	saturday: 6,
	satrday: 6,
	sunday: 7,
}

const dayOfWeekStringToLuxonWeekdayNumber = str => {
	if(!str) throw TypeError(`str must be defined. Got: \`${str}\``);
	const result = LUXON_DAYS_OF_WEEK[str.toLowerCase().trim()];
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


const getRowContent = sheet => rowNumber => map(COLUNM_COUNT, i => sheet.getCell(rowNumber, i)._rawData.formattedValue);

const containsNumbers = str => MATCHES_DIGITS_REGEX.test(str);


exports.retrieveFormattedMeetingFromSheet = retrieveFormattedMeetingFromSheet;