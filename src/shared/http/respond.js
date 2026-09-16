function sendData(res, data, status = 200, meta) {
  const body = { data };
  if (meta !== undefined) body.meta = meta;
  return res.status(status).json(body);
}

module.exports = { sendData };
