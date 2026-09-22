const mongoose = require('mongoose');
const config = require('../../../config/config');

function MongoClient() {
    this.options = {};
}

MongoClient.prototype.initialize = function () {
    return mongoose
        .connect(config.DB_URL, this.options)
        .then(() => log.yellow('Database connected'))
        .catch((error) => {
            throw error;
        });
};

MongoClient.prototype.mongify = function (id) {
    return mongoose.Types.ObjectId(id);
};

MongoClient.prototype.isEqual = (id1, id2) =>
    (id1 ? id1.toString() : id1) === (id2 ? id2.toString() : id2);

module.exports = new MongoClient();
