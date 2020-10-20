const AWS = require('aws-sdk');


async function invalidateCdn({files: s3FileKeys, awsCredentials}) {
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
        Quantity: s3FileKeys.length,
        Items: s3FileKeys
      }
    }
  };

  console.log("🌀 Invalidating CDN...");
  await new AWS.CloudFront(awsCredentials).createInvalidation(options).promise();

  console.log("✅ Invalidated");
}

exports.default = invalidateCdn;
exports.invalidateCdn = invalidateCdn;