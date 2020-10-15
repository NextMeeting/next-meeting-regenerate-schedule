require('dotenv').config();


const fs = require('fs');
const path = require('path');

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


//loadEnvVars();



process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "Hey!"
console.log(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
const { handler } = require("../app.js");

// handler();