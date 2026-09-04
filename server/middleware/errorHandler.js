// Единая обработка ошибок для всех роутов
module.exports = function errorHandler(err, req, res, next) {
  console.error(err);
  res.status(err.status || 500).json({
    error: err.message || "Внутренняя ошибка сервера",
  });
};
