const { FIELDS } = require('./_lib/schema');
const { json } = require('./_lib/util');

module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  json(res, 200, { fields: FIELDS });
};
