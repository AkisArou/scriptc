"use strict";
var response = await fetch("".concat(process.argv[2], "/text"));
var status = response.status;
var body = await response.text();
console.log(status, body);
export {};
