require("babel-polyfill");
import { MailAdapter } from 'parse-server/lib/Adapters/Email/MailAdapter';
import { Credentials, SESV2 } from 'aws-sdk';
import template from 'lodash.template';
import co from 'co';
import fs from 'fs';
import path from 'path';
import juice from 'juice';

/**
 * MailAdapter implementation used by the Parse Server to send
 * password reset and email verification emails though AmazonSES
 * @class
 */
class AmazonSESAdapter extends MailAdapter {
  constructor(options = {}) {
    super(options);

    const {
      accessKeyId,
      secretAccessKey,
      region,
      fromAddress
    } = options;
    if (!accessKeyId || !secretAccessKey || !region || !fromAddress) {
      throw new Error('AmazonSESAdapter requires valid fromAddress, accessKeyId, secretAccessKey, region.');
    }

    const {
      templates = {}
    } = options;
    ['passwordResetEmail', 'verificationEmail'].forEach((key) => {
      const {
        subject,
        pathPlainText,
        callback
      } = templates[key] || {};
      if (typeof subject !== 'string' || typeof pathPlainText !== 'string')
        throw new Error('AmazonSESAdapter templates are not properly configured.');

      if (callback && typeof callback !== 'function')
        throw new Error('AmazonSESAdapter template callback is not a function.');
    });

    this.ses = new SESV2({ credentials: new Credentials({ accessKeyId, secretAccessKey }), region });
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
      pathPlainText, pathHtml, htmlInliner;

    if (options.templateName) {
      const {
        templateName,
        subject,
        fromAddress,
        recipient,
        variables
      } = options;
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
      const {
        link,
        appName,
        user,
        templateConfig
      } = options;
      const {
        callback
      } = templateConfig;
      let userVars;

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
        link,
        appName,
        username: user.get('username'),
        email: user.get('email') || user.get('username')
      }, userVars);

      message = {
        from: this.fromAddress,
        to: user.get('email') || user.get('username'),
        subject: templateConfig.subject
      };
    }
    return co(function*() {
      let plainTextEmail, htmlEmail, compiled;

      // Load plain-text version
      plainTextEmail = yield loadEmailTemplate(pathPlainText);
      plainTextEmail = plainTextEmail.toString('utf8');

      // Compile plain-text template
      compiled = template(plainTextEmail, {
        interpolate: /{{([\s\S]+?)}}/g
      });
      // Add processed text to the message object
      message.text = compiled(templateVars);

      // Load html version if available
      if (pathHtml) {
        htmlEmail = yield loadEmailTemplate(pathHtml);
        
        // Compile html template
        compiled = template(htmlEmail, {
          interpolate: /{{([\s\S]+?)}}/g
        });
        
        // Add processed HTML to the message object
        let compiledHtml = compiled(templateVars)
        
        if(htmlInliner) {
          compiledHtml = juice(compiledHtml.toString('utf8'));
        }
        
        message.html = compiledHtml;
      }

      return {
        Content: {
          Simple: {
            Body: {
              Html: {
                Data: message.html,
              },
              Text: {
                Data: message.text,
              }
            },
            Subject: {
              Data: message.subject,
            },
          },
        },
        Destination: {
          ToAddresses: [
            message.to,
          ]
        },
        FromEmailAddress: message.from,
      };

    }).then(payload => {
      return new Promise((resolve, reject) => {
        this.ses.sendEmail(payload, (error, data) => {
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
  sendPasswordResetEmail({link, appName, user}) {
    return this._sendMail({
      link,
      appName,
      user,
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
  sendVerificationEmail({link, appName, user}) {
    return this._sendMail({
      link,
      appName,
      user,
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
  send({templateName, subject, fromAddress, recipient, variables = {}}) {
    return this._sendMail({
      templateName,
      subject,
      fromAddress,
      recipient,
      variables
    });
  }

  /**
   * Simple Promise wrapper to asynchronously fetch the contents of a template.
   * @param {string} path
   * @returns {promise}
   */
  loadEmailTemplate(path) {
    return new Promise((resolve, reject) => {
      fs.readFile(path, (err, data) => {
        if (err) reject(err);
        resolve(data);
      });
    });
  }

}

module.exports = AmazonSESAdapter;
