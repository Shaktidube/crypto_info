const helpers = {};

helpers.catchServerError = (name, error, res) => {
    console.error(name, error);
    return res.reply(messages.server_error());
};

helpers.isUserName = (name) => !/^[a-zA-Z ]+$/.test(name);

helpers.isPassword = (password) =>
    !/^(?=.*?[A-Z])(?=.*?[a-z])(?=.*?[0-9])(?=.*?[#?!@$%^&*-]).{8,15}$/.test(
        password,
    );

module.exports = helpers;
