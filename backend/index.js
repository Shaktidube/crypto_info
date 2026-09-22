require('./globals');

const { mongodb } = require('./app/utils');
const router = require('./app/routers');
const coindcxCandleScanner = require('./app/services/coindcx/coindcxCandleScanner');

async function bootstrap() {
    await mongodb.initialize();
    router.initialize();
    await coindcxCandleScanner.initialize();
}

bootstrap().catch((error) => {
    log.error('Application bootstrap failed', error);
    process.exitCode = 1;
});

async function shutdown() {
    await coindcxCandleScanner.stop();
    router.httpServer.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
