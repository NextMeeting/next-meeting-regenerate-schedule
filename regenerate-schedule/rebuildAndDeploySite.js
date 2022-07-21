 const fs = require('fs');
 const path = require('path');

const { generateSchedule } = require("./generateSchedule.js")

const { updateStaticSite } = require("./updateStaticSite.js")
const { parseBoolean  } = require("./global.js");

const DEBUG_FILE_DIRECTORY = './debug'
const DEBUG_FILE_NAME = 'schedule.json'



async function rebuildAndDeploySite({ name, googleSheetId, siteUUID }) {
	console.log(`\nRebuilding site "${name}" ${siteUUID}`)
	const jsonSchedule = await generateSchedule( googleSheetId ); 
  console.log("Generated schedule")

  if(process.env.WRITE_DEBUG_FILES && parseBoolean(process.env.WRITE_DEBUG_FILES)) {
    if(!fs.existsSync(DEBUG_FILE_DIRECTORY)) fs.mkdirSync(DEBUG_FILE_DIRECTORY)
    const DEBUG_FILE_PATH = path.join(DEBUG_FILE_DIRECTORY, DEBUG_FILE_NAME)
    fs.writeFileSync(DEBUG_FILE_PATH, JSON.stringify(jsonSchedule));
    console.log(`✅ Wrote debug file to ${DEBUG_FILE_PATH}`);
  }
		
  console.log("🌀 Rebuilding site...")
	await rebuildSite({jsonSchedule, siteUUID})
  console.log("✅ Done!")
}


// Helpers

async function rebuildSite({jsonSchedule, siteUUID}) {
	return await updateStaticSite({
  	jsonSchedule: jsonSchedule,
  	templateFileKey: `${siteUUID}.template.html`,
  	uploadFileName: `${siteUUID}.html`,
		siteUUID
	}); 
}


// Exports

exports.default = rebuildAndDeploySite;
exports.rebuildAndDeploySite = rebuildAndDeploySite;