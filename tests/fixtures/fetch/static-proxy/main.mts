const response = await fetch(`${process.argv[2]}/text`);
console.log(response.status, await response.text());
