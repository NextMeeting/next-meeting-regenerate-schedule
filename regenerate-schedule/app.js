/*

1. Retrive latest defect list from Google Sheets
2. Build index
3. Deploy JSON to Google Cloud Storage

*/



require("isomorphic-fetch");

const AWS = require('aws-sdk');
const Honeybadger = require('@honeybadger-io/js')

const { validateEnvVars, parseBoolean, asyncForEach, asyncMap, sendSlackNotification, sendErrorNotification, getCloudWatchLogDeeplink, sleep, loadEnvVars, readFile, resolveFilePath, pipe, map, sendHoneybadgerCheckIn, asyncParallelForEach } = require("./global.js");

const { updateStaticSite } = require("./updateStaticSite.js")
const { rebuildAndDeploySite }  = require('./rebuildAndDeploySite.js');
const { invalidateCdn } = require("./invalidateCdn.js")

const DEVELOPMENT_ENV_FILE_PATH = "../.env"


const RUNNING_IN_DEVELOPMENT_MODE = !process.env.AWS_LAMBDA_LOG_GROUP_NAME;




// If we're running outside of AWS Lambda, load 
// env vars from a .env file in project root
if(RUNNING_IN_DEVELOPMENT_MODE) loadEnvVars(DEVELOPMENT_ENV_FILE_PATH);


Honeybadger.configure({
  apiKey: process.env.HONEYBADGER_API_KEY
});


validateEnvVars([
  "GOOGLE_API_CLIENT_EMAIL",
  "GOOGLE_API_PRIVATE_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "CLOUDFRONT_DISTRIBUTION_ID",
  "AWS_S3_BUCKET",
  "AWS_S3_REGION",
  "SLACK_WEBHOOK_URL",
  "STATIC_SITE_S3_BUCKET"
])


// Inject special SIM sessions
function getSIMSessions() {
  return []
  const json = JSON.parse(readFile("./sim-2021.json"));
  const formattedMeetings = [];

  json.channels.forEach(channel => {
    channel.sessions.forEach(session => {
      formattedMeetings.push({
        name: `📺 SIM 2021: ${session.title}, with ${session.speaker}`,
        nextOccurrence: session.startTimestamp,
        connectionDetails: {
          platform: 'zoom',
          mustContactForConnectionInfo: false,
          meetingId: channel.connectionDetails.zoomId,
          password: channel.connectionDetails.zoomPassword,
          joinUrl: channel.connectionDetails.joinUrl
        },
        contactInfo: `Learn more at simhp.com. Contact us: register@simhp.com`,
        notes: "",
        participantCount: "",
        durationMinutes: 60,
        metadata: {
          hostLocation: "",
          localTimezoneOffset: undefined, 
          language: "en",
          fellowship: "sa",
          restrictions: {
            openMeeting: false,
            gender: "ALL",
          }
        }
      })
    })
  })
  return formattedMeetings;
}

const configs = [ 
  {
    name: "S-Anon",
    googleSheetId: '1UJneS5GKFQSIy_iAfkLE21nRC_E8VzJ8diTT4Z3JnrA',
    siteUUID: 'B0E7F18B-4CF5-49FF-BBD3-75E1CA52AA5E'
  },
  {
    name: 'SA',
    googleSheetId: '1_QxT6VIm1HTLKSl71DtDqSMWVZYrdbqSl0WSF0Ch6g4',
    siteUUID: '275EE30A-220F-4FF2-A950-0ED2B5E4C257'
  },
  {
    name: 'ACA',
    googleSheetId: '1EyR9SJSbEn0rIKtb10hYTQQCBHdJ42pBKFE6ezQeY8A',
    siteUUID: '0BF67B1D-444F-45F5-BA5B-E3ADD7E4C30B'
  },
  {
    name: 'DA',
    googleSheetId: '18gkS_5ghZGW0smYwV0OHYZL4yph-r02wIcVXujEF8HQ',
    siteUUID: 'A93E4DF2-F779-4F15-B25B-826D8A3B8009-DA'
  },
  {
    name: 'AAA',
    googleSheetId: '1RkJpxqJCHeQZjr0yYt6QMheujiynsCwY9M7G3BeV55E',
    siteUUID: '5205ac4c-ec58-4f11-8c90-2be7fcd4d6f5-AAA'
  }
]


exports.handler = async (event, context) => {

  try {
      
     const errors = [];
     await asyncForEach(configs, async (config) => {
       try {
         await rebuildAndDeploySite(config)
       } catch(error) {
         console.error(`❗  Caught error in deploy!`)
         console.error(error)
         errors.push(error);
         await Honeybadger.notifyAsync(error);
       }
     })

    
    await invalidateCdn({
      files:[
        "/*",
      ],
      awsCredentials: {
        // In prod, picks up creds from environment
        // accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        // secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      }
    });

    console.log(`✅ Success!`);
    
    await sendSlackNotification("✅ NextMeeting schedules regenerated")
    await sendHoneybadgerCheckIn();
    
    return { statusCode: 200, body: 'Success' }
  } catch (err) {
    console.error(`❗️ Error! ${err} ${JSON.stringify(err)}`);
    await Honeybadger.notifyAsync(error);
    await sendSlackNotification(`❗️ Error! ${err} ${JSON.stringify(err)}`);
    return { statusCode: 500, body: JSON.stringify(err) }
  }
}

// Dev only
if(RUNNING_IN_DEVELOPMENT_MODE) {
  exports.handler();
}

