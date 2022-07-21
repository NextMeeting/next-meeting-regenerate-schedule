// Imports

require("isomorphic-fetch");
const fs = require('fs');
const zlib = require('zlib');

const { GoogleSpreadsheet } = require('google-spreadsheet');
const AWS = require('aws-sdk');

const { DateTime } = require("luxon");
const extractEmail = require('extract-email-address');

const { map } = require("./global.js");
const { retrieveFormattedMeetingFromSheet } = require("./formatMeeting.js");

const ROWS_OCCUPIED_BY_HEADER = 2;
const ROWS_TO_IGNORE_FROM_END = 2;

// Main

async function generateSchedule( googleSheetId ) {
	const sheet = await downloadSheet(googleSheetId);
	
	const allMeetings = extractFormattedMeetings(sheet);
	
	// const simMeetings = getSIMSessions(); const allMeetings = beforeFiltering.concat(simMeetings)
	
	console.log(`Before filter: ${allMeetings.length} entries`);
	const meetingList = allMeetings.
		filter(isDefined).
		sort(sortMeetingFn);
	
	console.log(`Generated schedule (${meetingList.length} total meetings)`);
	
	writeDebugFiles(meetingList);
	return {
		metadata: {
			scheduleType: "fullWeek",
			generatedAt: new Date().toISOString(),
		},
		meetings: meetingList
	};
}

// Helpers

function extractFormattedMeetings(sheet) {
	const meetingCount = sheet.rowCount - ROWS_TO_IGNORE_FROM_END;
	console.log(`${meetingCount} raw meetings`);
	
	return map(meetingCount, retrieveFormattedMeetingFromSheet(sheet));
}

async function downloadSheet(sheetId) {
	const doc = await getGoogleSheetsDoc(sheetId);
	const sheet = doc.sheetsByIndex[0];
	console.log(sheet.title);
	
	console.log("🌀 Downloading sheet data...");
	await sheet.loadCells();
	console.log("✅ Download complete");
	
	return sheet;
}

async function getGoogleSheetsDoc(docId) {
	const doc = new GoogleSpreadsheet(docId);
	
	await doc.useServiceAccountAuth({
		client_email: process.env.GOOGLE_API_CLIENT_EMAIL,
		private_key: process.env.GOOGLE_API_PRIVATE_KEY.replace(/\\n/g, "\n")
	});

	await doc.loadInfo();
	return doc;
}

function sortMeetingFn({nextOccurrence: a}, {nextOccurrence: b}) {
	if(a < b) return -1;
	if(a > b) return 1;
	return 0;
}

function isDefined(item) {
	return item !== undefined;
}


function writeDebugFiles(fullJsonSchedule) {
	if(process.env.RUN_LOCAL) {
		console.log(`[dev] Writing files to local disk`);
		fs.writeFileSync("meetingsNext7Days.json", JSON.stringify(fullJsonSchedule));
		console.log(`✅ Done`);
	}
}

// Exports

exports.generateSchedule = generateSchedule;