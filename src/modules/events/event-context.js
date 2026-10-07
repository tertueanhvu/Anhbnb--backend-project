const { AsyncLocalStorage } = require("node:async_hooks");
const eventContext = new AsyncLocalStorage();
module.exports = { eventContext };
