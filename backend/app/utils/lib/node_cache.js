const NodeCache = require( 'node-cache' );
const globalCache = new NodeCache();

module.exports = globalCache;