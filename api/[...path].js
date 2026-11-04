const { createServer } = require("../server");

const server = createServer();

module.exports = function handler(request, response) {
  server.emit("request", request, response);
};
