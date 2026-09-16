const { sendData } = require("../../shared/http/respond");

function createAuthController(service) {
  return {
    async register(req, res) {
      return sendData(res, await service.register(req.body), 201);
    },
    async login(req, res) {
      return sendData(res, await service.login(req.body));
    },
    async me(req, res) {
      return sendData(res, await service.getProfile(req.auth.id));
    },
    async updateMe(req, res) {
      return sendData(res, await service.updateProfile(req.auth.id, req.body));
    },
  };
}

module.exports = { createAuthController };
