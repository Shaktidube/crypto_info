const http = require('http');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const routes = require('./routes');
const config = require('../../config/config');
const {
    globalApiLimiter,
    authApiLimiter,
    publicApiLimiter,
} = require('../utils/lib/rateLimiter');

function Router() {
    this.app = express();
    this.httpServer = http.createServer(this.app);
    this.corsOptions = {
        origin: '*',
        // origin: ['http://localhost:5000'],
        methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    };
}

Router.prototype.initialize = function () {
    this.setupMiddleware();
    this.setupServer();
};

Router.prototype.setupMiddleware = function () {
    this.app.disable('etag');
    this.app.enable('trust proxy');
    this.app.use(cors(this.corsOptions));
    this.app.use(helmet());
    this.app.use(compression());
    this.app.use(this.routeConfig);
    // Stripe signature verification requires the exact, unparsed request body.
    this.app.post(
        '/api/v1/billing/webhook',
        bodyParser.raw({ type: 'application/json' }),
        require('./billing/controllers').stripeWebhook,
    );
    this.app.use(bodyParser.json({ limit: '16mb' }));
    this.app.use(
        bodyParser.urlencoded({
            limit: '16mb',
            extended: true,
            parameterLimit: 50000,
        })
    );

    if (config.NODE_ENV !== 'prod') {
        this.app.use(
            morgan('dev', {
                skip: (req) =>
                    req.path === '/ping' || req.path === '/favicon.ico',
            })
        );
    }
    this.app.use(express.static('./seeds'));
    this.app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
    // Per-IP rate limits (requires trust proxy for correct client IP behind ngrok/LB).
    this.app.use('/api/v1/public', publicApiLimiter);
    this.app.use('/api/v1/auth', authApiLimiter);
    this.app.use('/api/v1', globalApiLimiter);
    this.app.use('/api/v1', routes);
    this.app.get('/callback', require('./auth/controllers').krakenOAuthRedirect);
    this.app.use('*', this.routeHandler);
    this.app.use(this.logErrors);
    this.app.use(this.errorHandler);
};

Router.prototype.setupServer = function () {
    this.httpServer = http.Server(this.app);
    this.httpServer.timeout = 60000;
    // keepAliveTimeout must exceed the load balancer's idle timeout (typically 60s on AWS ALB)
    // to prevent the LB sending a request on a connection Node has already closed (502 errors).
    this.httpServer.keepAliveTimeout = 65000;
    this.httpServer.headersTimeout = 66000;
    console.warn(`${config.SITE_NAME}-Backend`);
    this.httpServer.listen(config.PORT, '0.0.0.0', () =>
        log.green(`Spinning on ${config.PORT}`)
    );
};

Router.prototype.routeConfig = function (req, res, next) {
    req.sRemoteAddress =
        req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    if (req.path === '/healthcheck') return res.status(200).send({ message: '200' });
    res.reply = ({ code, message }, data = {}, header = undefined) => {
        res.status(code).header(header).json({ message, data });
    };
    next();
};

Router.prototype.routeHandler = function (req, res) {
    res.status(404);
    res.send({ message: 'Route not found' });
};

Router.prototype.logErrors = function (err, req, res, next) {
    log.error(`${req.method} ${req.url}`);
    log.error('body -> ', req.body);
    log.error(err.stack);
    return next(err);
};

Router.prototype.errorHandler = function (err, req, res, next) {
    res.status(500);
    res.send({ message: err });
};

module.exports = new Router();
