"use strict";
try {
    var response = await fetch(process.argv[2]);
    var status_1 = response.status;
    var body_1 = await response.text();
    console.log(status_1, body_1);
}
catch (error) {
    var caught_1 = error;
    console.log(caught_1.name, caught_1.message, caught_1 instanceof TypeError);
}
export {};
