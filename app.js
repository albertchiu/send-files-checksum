const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config.json');
const nodemailer = require('nodemailer');
const zlib = require('zlib');
const filterRegExp = /(?:)/;//new RegExp('');
const algorithm = 'sha256';

function iterateFiles(startPath, filter, callback) {
    if (!fs.existsSync(startPath)) {
        console.log('no dir ', startPath);
        return;
    }

    let files = fs.readdirSync(startPath);
    for (let i = 0; i < files.length; i++) {
        let filename = path.join(startPath, files[i]);
        let stat = fs.lstatSync(filename);
        if (stat.isDirectory()) {
            iterateFiles(filename, filter, callback); //recurse
        }
        else if (filter.test(filename)) {
            callback(filename);
        }
    }
}

function checksum(str = '', algorithm, encoding) {
    return crypto
        .createHash(algorithm || 'md5')
        .update(str, 'utf8')
        .digest(encoding || 'hex');
}

function sendmail(smtpTransport, message) {
    smtpTransport.sendMail(message, (error, response) => {
        if (error) {
            console.log(error);
        } else {
            console.log(`Send mail:  ${message.subject}`);
        }
    });
}

function getMailMessage(cfg, checkResults, compress) {
    let mailSubject = cfg.mail.subject || 'no subject';
    let mailBody = `algorithm: ${algorithm}\r\nexecution timestamp: ${new Date().toLocaleString()}\r\n\r\n`;
    let attachments = [];
    for (let result of checkResults) {
        let { appName, hashResult } = result;
        let attach;
        if (compress) {
            attach = { filename: `${appName}.txt.gz`, content: compress(hashResult), contentType: 'application/x-gzip' }
        } else {
            attach = { filename: `${appName}.txt`, content: hashResult, contentType: 'text/plain' }
        }
        attachments.push(attach);
        mailBody += `${attach.filename}: ${checksum(attach.content, algorithm)}\r\n`;
    }

   return {
        from: cfg.mail.mailFrom,
        to: cfg.mail.recipients,
        subject: mailSubject,
        text: mailBody,
        attachments: attachments
    };
}

function getMailTransporter(cfg, mailer) {
    return mailer.createTransport({
        host: cfg.host || '127.0.0.1',
        port: cfg.port || 25,
        secure: false
    });
}

function startCheckAndGetResult(cfg) {
    let checkResults = [];
    let apps = cfg.apps || [];

    for (let app of apps) {
        try {
            let { startPath } = app;
            let temp = [];
            iterateFiles(startPath, filterRegExp, filename => {
                let contents = fs.readFileSync(filename);
                let relativePath = path.relative(startPath, filename);
                temp.push(`${relativePath} -> ${checksum(contents, algorithm)}`);
            });
            let { appName } = app;
            let hashResult = temp.join('\r\n');
            checkResults.push({ appName, hashResult });
        }
        catch (ex) {
            console.log(ex);
        }
    }
    return checkResults;
}

function go() {
    let smtpCfg = config.smtp || {};
    let checksumCfgs = config.checksums || [];
    let transporter = getMailTransporter(smtpCfg, nodemailer);

    for (let cfg of checksumCfgs) {
        try {
            let checkResults = startCheckAndGetResult(cfg);
            let mailMessage = getMailMessage(cfg, checkResults, input => zlib.gzipSync(input));
            sendmail(transporter, mailMessage);
        }
        catch (ex) {
            console.log(ex);
        }
    }
}

go();
