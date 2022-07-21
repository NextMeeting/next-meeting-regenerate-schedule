const { sleep, uploadJsonFile } = require("./global.js");

const S3_DOWNLOAD_RETRY_TIMEOUT_DEFAULT_MS = 300;
//const STATIC_SITE_BUCKET = "next-meeting-static-site";

const HTML_TEMPLATE_FILE_KEY = "index.template.html";
const HTML_TEMPLATE_JSON_INJECT_MARKER = "/* INJECT_SCHEDULE_JSON */"
const HTML_GENERATED_FILE_NAME = "index.html";

const AWS = require('aws-sdk');



// Main

async function updateStaticSite({
  jsonSchedule,
  templateFileKey,
  uploadFileName,
  siteUUID
}) {
  
  console.log("ℹ️ Updating static site");
  const deployBucket = process.env.STATIC_SITE_S3_BUCKET;
    
  console.log('AWS creds:')  
  console.log(process.env.AWS_ACCESS_KEY_ID)
  console.log(process.env.AWS_SECRET_ACCESS_KEY)
  
  let s3 = new AWS.S3({ 
    // Will pick up creds in prod automatically
    // accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    // secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    params: { Bucket: deployBucket }
  });

  console.log("🌀 Downloading template HTML...");
  
  const templateHtml = await downloadS3File({ bucket: process.env.S3_BUCKET_NAME, fileS3Key: templateFileKey, s3});
  const jsonToInject = `const JSON_SCHEDULE=${JSON.stringify(jsonSchedule)}`
  const populatedHtml = templateHtml.replace(HTML_TEMPLATE_JSON_INJECT_MARKER, jsonToInject);
  
  
  
  console.log("ℹ️ Injected schedule JSON");

  console.log("🌀 Uploading built HTML...");
  await s3.upload({
    Bucket: deployBucket,
    Key:  uploadFileName,
    Body: populatedHtml,
    ContentType: "text/html"
  }).promise()
  console.log(`✅ Done`);
  
  
  console.log("🌀 Uploading JSON version...");
  await s3.upload({
    Bucket: deployBucket,
    Key:  `${siteUUID}.json`,
    Body: JSON.stringify(jsonSchedule),
    ContentType: "application/json"
  }).promise()
  console.log(`✅ Done`);
  
  console.log(`✅ Static site redeployed`);
}



const downloadS3File = async ({bucket, fileS3Key, s3}) => {
  let retriesRemaining = 3;
  const S3_RETRY_TIMEOUT_MS = process.env.S3_DOWNLOAD_RETRY_TIMEOUT_MS || S3_DOWNLOAD_RETRY_TIMEOUT_DEFAULT_MS;
  let response, error;
  
  while(response === undefined && retriesRemaining > 0) {
    try {
      console.log(`Attempting S3 download. (${retriesRemaining} retries remaining)`);
      
      response = await s3.getObject({ Bucket: bucket, Key: fileS3Key}).promise();
      
      console.log("Loop end. response:");
      console.log(response);
      retriesRemaining -= 1;
    } catch(e) {
      error = e;
      console.error(e);
      retriesRemaining -= 1;
      await sleep(S3_RETRY_TIMEOUT_MS);
    }
  }

  if(response !== undefined) return response.Body.toString();
  throw {name: "S3_DOWNLOAD_FAILED", fileS3Key, error};
}

exports.default = updateStaticSite;
exports.updateStaticSite = updateStaticSite;