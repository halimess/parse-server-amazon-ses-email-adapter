'use strict';

var _lodash = require('lodash.template');

var _lodash2 = _interopRequireDefault(_lodash);

var _co = require('co');

var _co2 = _interopRequireDefault(_co);

var _fs = require('fs');

var _fs2 = _interopRequireDefault(_fs);

var _path = require('path');

var _path2 = _interopRequireDefault(_path);

var _juice = require('juice');

var _juice2 = _interopRequireDefault(_juice);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

require("babel-polyfill");
const AmazonSES = require('../yo-amazon-ses-mailer');


/**
 * MailAdapter implementation used by the Parse Server to send
 * password reset and email verification emails though AmazonSES
 * @class
 */
class MailAdapter {
  /*
   * A method for sending mail
   * @param options would have the parameters
   * - to: the recipient
   * - text: the raw text of the message
   * - subject: the subject of the email
   */
  sendMail(options) {}

  /* You can implement those methods if you want
   * to provide HTML templates etc...
   */
  // sendVerificationEmail({ link, appName, user }) {}
  // sendPasswordResetEmail({ link, appName, user }) {}
}

class AmazonSESAdapter extends MailAdapter {
  constructor() {
    let options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

    super(options);

    const accessKeyId = options.accessKeyId,
          secretAccessKey = options.secretAccessKey,
          region = options.region,
          fromAddress = options.fromAddress;

    if (!accessKeyId || !secretAccessKey || !region || !fromAddress) {
      throw new Error('AmazonSESAdapter requires valid fromAddress, accessKeyId, secretAccessKey, region.');
    }

    var _options$templates = options.templates;
    const templates = _options$templates === undefined ? {} : _options$templates;

    ['passwordResetEmail', 'verificationEmail'].forEach(key => {
      var _ref = templates[key] || {};

      const subject = _ref.subject,
            pathPlainText = _ref.pathPlainText,
            callback = _ref.callback;

      if (typeof subject !== 'string' || typeof pathPlainText !== 'string') throw new Error('AmazonSESAdapter templates are not properly configured.');

      if (callback && typeof callback !== 'function') throw new Error('AmazonSESAdapter template callback is not a function.');
    });

    this.ses = new AmazonSES(accessKeyId, secretAccessKey, region);
    this.fromAddress = fromAddress;
    this.templates = templates;
  }

  /**
   * Method to send emails via AmazonSESAdapter
   *
   * @param {object} options, options object with the following parameters:
   * @param {string} options.subject, email's subject
   * @param {string} options.link, to reset password or verify email address
   * @param {object} options.user, the Parse.User object
   * @param {string} options.pathPlainText, path to plain-text version of email template
   * @param {string} options.pathHtml, path to html version of email template
   * @returns {promise}
   */
  _sendMail(options) {
    const loadEmailTemplate = this.loadEmailTemplate;
    let message = {},
        templateVars = {},
        pathPlainText,
        pathHtml,
        htmlInliner;
    var configurationSetName; // function scope;

    if (options.templateName) {
      const templateName = options.templateName,
            subject = options.subject,
            fromAddress = options.fromAddress,
            recipient = options.recipient,
            variables = options.variables;

      configurationSetName = options.configurationSetName;
      let template = this.templates[templateName];

      if (!template) throw new Error(`Could not find template with name ${templateName}`);
      if (!subject && !template.subject) throw new Error(`Cannot send email with template ${templateName} without a subject`);
      if (!recipient) throw new Error(`Cannot send email with template ${templateName} without a recipient`);

      pathPlainText = template.pathPlainText;
      pathHtml = template.pathHtml;
      htmlInliner = template.htmlInliner;

      templateVars = variables;

      message = {
        from: fromAddress || this.fromAddress,
        to: recipient,
        subject: subject || template.subject
      };
    } else {
      const link = options.link,
            appName = options.appName,
            user = options.user,
            templateConfig = options.templateConfig;
      const callback = templateConfig.callback;

      let userVars;
      configurationSetName = templateConfig.configurationSetName;

      if (callback && typeof callback === 'function') {
        userVars = callback(user);
        // If custom user variables are not packaged in an object, ignore it
        const validUserVars = userVars && userVars.constructor && userVars.constructor.name === 'Object';
        userVars = validUserVars ? userVars : {};
      }

      pathPlainText = templateConfig.pathPlainText;
      pathHtml = templateConfig.pathHtml;
      htmlInliner = templateConfig.htmlInliner;

      templateVars = Object.assign({
        link: link,
        appName: appName,
        username: user.get('username'),
        email: user.get('email') || user.get('username')
      }, userVars);

      message = {
        from: this.fromAddress,
        to: user.get('email') || user.get('username'),
        subject: templateConfig.subject
      };
    }
    return (0, _co2.default)(function* () {
      let plainTextEmail, htmlEmail, compiled;

      // Load plain-text version
      plainTextEmail = yield loadEmailTemplate(pathPlainText);
      plainTextEmail = plainTextEmail.toString('utf8');

      // Compile plain-text template
      compiled = (0, _lodash2.default)(plainTextEmail, {
        interpolate: /{{([\s\S]+?)}}/g
      });
      // Add processed text to the message object
      message.text = compiled(templateVars);

      // Load html version if available
      if (pathHtml) {
        htmlEmail = yield loadEmailTemplate(pathHtml);

        // Compile html template
        compiled = (0, _lodash2.default)(htmlEmail, {
          interpolate: /{{([\s\S]+?)}}/g
        });

        // Add processed HTML to the message object
        let compiledHtml = compiled(templateVars);

        if (htmlInliner) {
          compiledHtml = (0, _juice2.default)(compiledHtml.toString('utf8'));
        }

        message.html = compiledHtml;
      }

      return {
        from: message.from,
        to: [message.to],
        subject: message.subject,
        body: {
          text: message.text,
          html: message.html
        },
        ConfigurationSetName: configurationSetName
      };
    }).then(payload => {
      return new Promise((resolve, reject) => {
        this.ses.send(payload, (error, data) => {
          if (error) reject(error);
          resolve(data);
        });
      });
    }, error => {
      console.error(error);
    });
  }

  /**
   * _sendMail wrapper to send an email with password reset link
   * @param {object} options, options object with the following parameters:
   * @param {string} options.link, to reset password or verify email address
   * @param {string} options.appName, the name of the parse-server app
   * @param {object} options.user, the Parse.User object
   * @returns {promise}
   */
  sendPasswordResetEmail(_ref2) {
    let link = _ref2.link,
        appName = _ref2.appName,
        user = _ref2.user;

    return this._sendMail({
      link: link,
      appName: appName,
      user: user,
      templateConfig: this.templates.passwordResetEmail
    });
  }

  /**
   * _sendMail wrapper to send an email with an account verification link
   * @param {object} options, options object with the following parameters:
   * @param {string} options.link, to reset password or verify email address
   * @param {string} options.appName, the name of the parse-server app
   * @param {object} options.user, the Parse.User object
   * @returns {promise}
   */
  sendVerificationEmail(_ref3) {
    let link = _ref3.link,
        appName = _ref3.appName,
        user = _ref3.user;

    return this._sendMail({
      link: link,
      appName: appName,
      user: user,
      templateConfig: this.templates.verificationEmail
    });
  }

  /**
   * _sendMail wrapper to send general purpose emails
   * @param {object} options, options object with the following parameters:
   * @param {object} options.templateName, name of template to be used
   * @param {object} options.subject, overrides the default value
   * @param {object} options.fromAddress, overrides the default from address
   * @param {object} options.recipient, email's recipient
   * @param {object} options.variables, an object whose property names represent
   *   template variables,vand whose values will replace the template variable
   *   placeholders
   * @returns {promise}
   */
  send(_ref4) {
    let templateName = _ref4.templateName,
        subject = _ref4.subject,
        fromAddress = _ref4.fromAddress,
        recipient = _ref4.recipient;
    var _ref4$variables = _ref4.variables;
    let variables = _ref4$variables === undefined ? {} : _ref4$variables,
        configurationSetName = _ref4.configurationSetName;

    return this._sendMail({
      templateName: templateName,
      subject: subject,
      fromAddress: fromAddress,
      recipient: recipient,
      variables: variables,
      configurationSetName: configurationSetName
    });
  }

  /**
   * Simple Promise wrapper to asynchronously fetch the contents of a template.
   * @param {string} path
   * @returns {promise}
   */
  loadEmailTemplate(path) {
    return new Promise((resolve, reject) => {
      _fs2.default.readFile(path, (err, data) => {
        if (err) reject(err);
        resolve(data);
      });
    });
  }

}

module.exports = AmazonSESAdapter;