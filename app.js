const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config.json');
const nodemailer = require('nodemailer');
const zlib = require('zlib');
const algorithm = 'md5';
const snapshotDir = './snapshot';

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
            iterateFiles(filename, filter, callback);
        }
        else if (filter.test(filename)) {
            callback(filename);
        }
    }
}

function checksum(str = '', algorithm = 'md5', encoding = 'hex') {
    return crypto
        .createHash(algorithm)
        .update(str, 'utf8')
        .digest(encoding);
}

function sendmail(smtpTransport, message) {
    smtpTransport.sendMail(message, (err, response) => {
        if (err) {
            console.log(err);
        } else {
            console.log(`Send mail:  ${message.subject}`);
        }
    });
}

function getMailMessage(cfg, checkResults, compress) {
    let mailSubject = cfg.mail.subject || 'no subject';
    let mailBody = `algorithm: ${algorithm}\r\nexecution timestamp: ${new Date().toLocaleString()}\r\n`;
    let attachments = [];
    for (let result of checkResults) {
        let { appName, hashResult } = result;
        let jsonStr = JSON.stringify([...hashResult], null, 2);
        let attach;
        if (compress) {
            attach = { filename: `${appName}.txt.gz`, content: compress(jsonStr), contentType: 'application/x-gzip' }
        } else {
            attach = { filename: `${appName}.txt`, content: jsonStr, contentType: 'text/plain' }
        }
        attachments.push(attach);

        mailBody += '\r\n--------------------------------------------------------------------------------------------------------------------------\r\n';
        mailBody += `${attach.filename}: ${checksum(attach.content, algorithm)}\r\n`;

        if (result.hasOwnProperty('diffResult')) {
            let diffResult = result.diffResult;
            if (typeof diffResult === 'string') {
                mailBody += `\r\n${diffResult}\r\n`;
            } else {
                mailBody += `\r\nFiles matched count : ${diffResult.matchedCount}\r\n`;
                mailBody += `\r\nNew files :\r\n  ${diffResult.newFiles.join('\r\n  ')}`;
                mailBody += `\r\nModified files :\r\n  ${diffResult.modifiedFiles.join('\r\n  ')}`;
                mailBody += `\r\nRemoved files :\r\n  ${diffResult.removedFiles.join('\r\n  ')}`;
            }
        }
    }
   return {
        from: cfg.mail.mailFrom,
        to: cfg.mail.recipients,
        subject: mailSubject,
        text: mailBody,
        attachments: attachments
    };
}

function getMailTransporter({ host = '127.0.0.1', port = 25 }, mailer) {
    return mailer.createTransport({
        host: host,
        port: port,
        secure: false
    });
}

function startCheckAndGetResult(cfg) {
    let checkResults = [];
    let { apps = [] } = cfg;
    for (let { startPath, appName, regExp, diff } of apps) {
        try {
            let hashResult = new Map();
            iterateFiles(startPath, new RegExp(regExp), filename => {
                let contents = fs.readFileSync(filename);
                let relativePath = path.relative(startPath, filename);
                hashResult.set(relativePath, checksum(contents, algorithm));
            });
            let result = { appName, hashResult };
            if (diff) {
                if (!fs.existsSync(snapshotDir)) {
                    fs.mkdirSync(snapshotDir);
                }
                if (fs.existsSync(`${snapshotDir}/${appName}.json`)) {
                    let jsonStr = fs.readFileSync(`${snapshotDir}/${appName}.json`, 'utf8');
                    let lastHashResult = new Map(JSON.parse(jsonStr));
                    result.diffResult = compareMaps(lastHashResult, hashResult);
                } else {
                    result.diffResult = 'Snapshot has been created';
                }
                fs.writeFile(`${snapshotDir}/${appName}.json`, JSON.stringify([...hashResult], null, 2), 'utf8', err => {
                    if (err) {
                        console.log(err);
                    }
                });
            }
            checkResults.push(result);
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

function compareMaps(map1, map2) {
    let matchedCount = 0;
    let newFileNames = [], modifiedFileNames = [], removedFileNames = [];

    for (let [fileName, hash] of map1) {
        if (map2.has(fileName)) {
            if (hash == map2.get(fileName)) {
                matchedCount++;
            } else {
                modifiedFileNames.push(fileName);
            }
        } else {
            removedFileNames.push(fileName);
        }
    }
    for (let [fileName, hash] of map2) {
        if (!map1.has(fileName)) {
            newFileNames.push(fileName);
        }
    }
    return {
        matchedCount: matchedCount,
        newFiles: newFileNames,
        modifiedFiles: modifiedFileNames,
        removedFiles: removedFileNames
    }
}

go();