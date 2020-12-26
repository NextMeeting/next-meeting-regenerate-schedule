const S3_DOWNLOAD_RETRY_TIMEOUT_DEFAULT_MS = 300;
//const STATIC_SITE_BUCKET = "next-meeting-static-site";

const HTML_TEMPLATE_FILE_KEY = "index.template.html";
const HTML_TEMPLATE_JSON_INJECT_MARKER = "/* INJECT_SCHEDULE_JSON */"
const HTML_GENERATED_FILE_NAME = "index.html";

const AWS = require('aws-sdk');

async function updateStaticSite(oneDaySchedule) {
  console.log("ℹ️ Updating static site");
  let s3 = new AWS.S3( { params: { Bucket: process.env.STATIC_SITE_S3_BUCKET } } );

  console.log("🌀 Downloading template HTML...");
  const html = await downloadS3File({fileS3Key: HTML_TEMPLATE_FILE_KEY, s3});

  // const indexOfCommitHash = html.indexOf("commitHash");
  // console.log(`✅ HTML was built from commit ${html.substring(indexOfCommitHash, 50)}`);

  const jsonToInject = `const JSON_SCHEDULE=${JSON.stringify(oneDaySchedule)}`
  const populatedHtml = html.replace(HTML_TEMPLATE_JSON_INJECT_MARKER, jsonToInject);
  console.log("ℹ️ Injected schedule JSON");

  console.log("🌀 Uploading built HTML...");
  await s3.upload({
    Bucket: process.env.STATIC_SITE_S3_BUCKET,
    Key:  HTML_GENERATED_FILE_NAME,
    Body: populatedHtml,
    ContentType: "text/html"
  }).
  promise()
  console.log(`✅ Static site redeployed`);
}



const downloadS3File = async ({fileS3Key, s3}) => {
  let retriesRemaining = 3;
  const S3_RETRY_TIMEOUT_MS = process.env.S3_DOWNLOAD_RETRY_TIMEOUT_MS || S3_DOWNLOAD_RETRY_TIMEOUT_DEFAULT_MS;
  let response, error;
  
  while(response === undefined && retriesRemaining > 0) {
    try {
      console.log(`Attempting S3 download. (${retriesRemaining} retries remaining)`);
      response = await s3.getObject({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: fileS3Key
      }).promise();
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