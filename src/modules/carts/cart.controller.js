const { sendData } = require("../../shared/http/respond");

function createCartController(service) {
  return {
    async get(req, res) {
      return sendData(res, await service.get(req.auth.id));
    },
    async add(req, res) {
      return sendData(res, await service.add(req.auth.id, req.body), 201);
    },
    async update(req, res) {
      return sendData(
        res,
        await service.update(req.auth.id, req.params.cartItemId, req.body),
      );
    },
    async remove(req, res) {
      await service.remove(req.auth.id, req.params.cartItemId);
      return res.status(204).end();
    },
    async clear(req, res) {
      await service.clear(req.auth.id);
      return res.status(204).end();
    },
  };
}

module.exports = { createCartController };
