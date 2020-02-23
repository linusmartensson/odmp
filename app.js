var createError = require('http-errors');
var express = require('express');
var logger = require('morgan');
var indexRouter = require('./balancer.js');
var app = express();
app.use(logger('dev'));
app.use(express.urlencoded({ extended: false }));
app.use('/', indexRouter);
app.use(function(req, res, next) {next(createError(404))});
app.use(function(err, req, res, next) {
  console.dir(err);
  res.status(err.status || 500).end();
});
module.exports = app;
