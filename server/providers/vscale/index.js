'use strict';

const _ = require('lodash'),
    Promise = require('bluebird'),
    API = require('./api'),
    InstanceModel = require('../../proxies/manager/instance.model'),
    ScalingError = require('../../common/error/scaling'),
    winston = require('winston');


module.exports = class ProviderVscale {
    constructor(config, instancePort) {
        if (!config || !instancePort) {
            throw new Error('[ProviderVscale] should be instanced with config and instancePort');
        }

        this._config = config;
        this._instancePort = instancePort;

        this.name = 'vscale';

        this._imagePromise = void 0;
        this._sshKeyPromise = void 0;

        this._api = new API(this._config.token);
    }


    static get ST_DEFINED() {
        return 'defined';
    }

    static get ST_CREATED() {
        return 'created';
    }

    static get ST_STARTED() {
        return 'started';
    }

    static get ST_STOPPED() {
        return 'stopped';
    }

    static get ST_BILLING() {
        return 'billing';
    }


    get models() {
        const self = this;

        return self._api.getAllScalets()
            .then(summarizeInfo)
            .then(excludeRegion)
            .then(excludeOutscope)
            .then(convertToModel);

        ////////////

        function summarizeInfo(scalets) {
            return _.map(scalets, (scalet) => ({
                id: scalet.ctid.toString(),
                status: scalet.status,
                locked: scalet.locked,
                ip: _.get(scalet, 'public_address.address'),
                name: scalet.name,
                region: scalet.location,
            }));
        }

        function excludeRegion(scalets) {
            return _.filter(scalets,
                (scalets0) => scalets0.region === self._config.region
            );
        }

        function excludeOutscope(scalets) {
            return _.filter(scalets,
                (scalet) => scalet.name && scalet.name.indexOf(self._config.name) === 0
            );
        }

        function convertToModel(scalets) {
            return _.map(scalets, (scalet) => new InstanceModel(
                scalet.id,
                self.name,
                convertStatus(scalet.status),
                scalet.locked,
                buildAddress(scalet.ip),
                scalet
            ));


            ////////////

            function buildAddress(ip) {
                if (!ip) {
                    return;
                }

                return {
                    hostname: ip,
                    port: self._instancePort,
                };
            }

            function convertStatus(status) {
                switch (status) {
                    case ProviderVscale.ST_DEFINED:
                    {
                        return InstanceModel.STARTING;
                    }
                    case ProviderVscale.ST_STARTED:
                    {
                        return InstanceModel.STARTED;
                    }
                    case ProviderVscale.ST_STOPPED:
                    {
                        return InstanceModel.STOPPED;
                    }
                    case ProviderVscale.ST_CREATED:
                    {
                        return InstanceModel.STARTING;
                    }
                    case ProviderVscale.ST_BILLING:
                    {
                        winston.error('[ProviderVscale] Error: Unsufficients funds');

                        return InstanceModel.ERROR;
                    }
                    default:
                    {
                        winston.error('[ProviderVscale] Error: Found unknown status:', status);

                        return InstanceModel.ERROR;
                    }
                }
            }
        }
    }

    createInstances(count) {
        const self = this;

        winston.debug('[ProviderVscale] createInstances: count=%d', count);

        return this._api.getAllScalets()
            .then((scalets) => {
                const actualCount = _(scalets)
                    .size();

                winston.debug('[ProviderVscale] createInstances: actualCount=%d', actualCount);

                if (this._config.maxRunningInstances && actualCount + count > this._config.maxRunningInstances) {
                    throw new ScalingError(count, true);
                }

                return init()
                    .spread((image, sshKey) => createInstances(count, image.id, sshKey.id));
            })
            .catch((err) => {
                throw err;
            });


        ////////////

        function init() {
            // Get image id
            if (!self._imagePromise) {
                self._imagePromise = getImageByName(self._config.imageName);
            }

            // Get ssh key id
            if (!self._sshKeyPromise) {
                self._sshKeyPromise = getSSHkeyByName(self._config.sshKeyName);
            }

            return Promise.all([
                self._imagePromise,
                self._sshKeyPromise,
            ]);


            ////////////

            function getImageByName(name) {
                return self._api.getAllImages()
                    .then((images) => {
                        const image = _.find(images, {name});
                        if (!image) {
                            throw new Error(`Cannot find image by name '${name}'`);
                        }

                        return image;
                    });
            }

            function getSSHkeyByName(name) {
                return self._api.getAllSSHkeys()
                    .then((sshKeys) => {
                        const sshKey = _.find(sshKeys, {name});
                        if (!sshKey) {
                            throw new Error(`Cannot find ssh_key by name '${name}'`);
                        }

                        return sshKey;
                    });
            }

        }

        function createInstances(countOfScalets, imageId, sshKeyId) {
            const createOptions = {
                name: self._config.name,
                location: self._config.region,
                rplan: self._config.plan,
                make_from: imageId,
                keys: [sshKeyId],
                do_start: true,
            };

            const promises = [];
            for (let i = 0; i < countOfScalets; ++i) {
                promises.push(self._api.createScalet(createOptions));
            }

            return Promise.all(promises);
        }
    }


    startInstance(model) {
        winston.debug('[ProviderVscale] startInstance: model=', model.toString());

        return this._api.startScalet(model.providerOpts.id);
    }


    removeInstance(model) {
        winston.debug('[ProviderVscale] removeInstance: model=', model.toString());

        return this._api.removeScalet(model.providerOpts.id);
    }
};
