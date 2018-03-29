'use strict';

 /*eslint-disable no-unused-vars */
const _ = require('lodash'),
 /*eslint-enable no-unused-vars */
    Promise = require('bluebird'),
    https = require('https'),
    url = require('url');


module.exports = class VscaleAPI {
    constructor(token) {
        this._token = token;
    }


    // SCALETS
    getAllScalets() {
        const options = {
            method: 'GET',
            path: '/scalets',
        };

        return this._makeRequest(options);
    }

    createScalet(params) {
        const options = {
            method: 'POST',
            path: '/scalets',
        };

        return this._makeRequest(options, params);
    }


    startScalet(id) {
        const options = {
            method: 'PATCH',
            path: `/scalets/${id}/start`,
        };

        return this._makeRequest(options);
    }


    removeScalet(id) {
        const options = {
            method: 'DELETE',
            path: `/scalets/${id}`,
        };

        return this._makeRequest(options)
            .catch((err) => {
                if (err.message) {
                    throw err.message;
                }
                else {
                    throw err;
                }
            });
    }


    // SSH KEYS
    getAllSSHkeys() {
        const options = {
            method: 'GET',
            path: '/sshkeys',
        };

        return this._makeRequest(options);
    }


    // IMAGES
    getAllImages() {
        const options = {
            method: 'GET',
            path: '/backups',
        };

        return this._makeRequest(options);
    }


    _makeRequest(options, body) {
        const path = url.format({
            pathname: `/v1${options.path}`,
            query: options.qs,
        });

        const reqOptions = {
            hostname: 'api.vscale.io',
            port: 443,
            method: options.method,
            path,
            headers: {
                'X-Token': this._token,
            },
        };

        // Add headers for payload
        let payload;
        if (body) {
            payload = JSON.stringify(body);

            reqOptions.headers['Content-Type'] = 'application/json';
            reqOptions.headers['Content-Length'] = Buffer.byteLength(payload);
        }

        return new Promise((resolve, reject) => {
                const req = https.request(reqOptions, (res) => {
                    const chunks = [];

                    res.on('error', (err) => reject(err));

                    res.on('end', () => {
                        let resBody = Buffer.concat(chunks).toString();

                    // Convert to JSON if possible
                    try {
                        resBody = JSON.parse(resBody);
                    }
                    catch (err) {
                        // Ignore
                    }

                    // Transform wrong status code to error
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        return reject(resBody);
                    }

                    resolve(resBody);
                });

                res.on('data', (chunk) => chunks.push(chunk));
            });

            req.on('error', (err) => reject(err));

            if (payload) {
                req.write(payload);
            }

            req.end();
        });
    }
};
