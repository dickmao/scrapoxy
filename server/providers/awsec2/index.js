'use strict';

const _ = require('lodash'),
    Promise = require('bluebird'),
    AWS = require('aws-sdk'),
    InstanceModel = require('../../proxies/manager/instance.model'),
    ScalingError = require('../../common/error/scaling'),
    winston = require('winston');


module.exports = class ProviderAWSEC2 {
    constructor(config, instancePort) {
        if (!config || !instancePort) {
            throw new Error('[ProviderAWSEC2] should be instanced with config and instancePort');
        }

        this._config = config;
        this._instancePort = instancePort;

        this.name = 'awsec2';
        this._vpcid = '';

        const metadata = new AWS.MetadataService();
        metadata.request('/latest/meta-data/mac', (err, mac) => {
            if (!err) {
                winston.debug('[ProviderAWSEC2] hey: Got the mac %s', mac);
                metadata.request(`/latest/meta-data/network/interfaces/macs/${mac}/vpc-id`,
                                 (err0, vpcid) => {
                                     if (!err0) {
                                         winston.debug('[ProviderAWSEC2] hey: Got the vpc %s', vpcid);
                                         this._vpcid = vpcid;
                                     }
                                     else {
                                         winston.error('[ProviderAWSEC2] vpc fail %s', err0);
                                     }
                                 });
            }
            else {
                winston.error('[ProviderAWSEC2] mac fail %s', err);
            }
        });
        const opts = _.pick(this._config, ['accessKeyId', 'secretAccessKey', 'region']);
        this._ec2 = new AWS.EC2(opts);
    }


    static get ST_PENDING() {
        return 'pending';
    }

    static get ST_RUNNING() {
        return 'running';
    }

    static get ST_SHUTTING_DOWN() {
        return 'shutting-down';
    }

    static get ST_TERMINATED() {
        return 'terminated';
    }

    static get ST_STOPPING() {
        return 'stopping';
    }

    static get ST_STOPPED() {
        return 'stopped';
    }


    get models() {
        const self = this;

        return describeInstances()
            .then(summarizeInfo)
            .then(excludeTerminated)
            .then(excludeOutscope)
            .then(convertToModel);


        ////////////


        function describeInstances() {
            return new Promise((resolve, reject) => {
                if (!self._vpcid) {
                    reject('serious');
                }
                else {
                    self._ec2.describeInstances(
                        {Filters: [
                            {Name: 'vpc-id', Values: [`${self._vpcid}`]},
                        ]}, (err, data) => {
                            if (err) {
                                return reject(err);
                            }

                            const instances = _(data.Reservations)
                                  .map('Instances')
                                  .flatten()
                                  .value();

                            resolve(instances);
                        });
                }
            });
        }

        function summarizeInfo(instancesDesc) {
            return _.map(instancesDesc, (instanceDesc) => ({
                    id: instanceDesc.InstanceId,
                    status: instanceDesc.State.Name,
                    ip: instanceDesc.PublicIpAddress,
                    tag: getTag(instanceDesc),
            }));

            ////////////

            function getTag(instanceDesc) {
                if (!instanceDesc.Tags) {
                    return;
                }

                const first = _(instanceDesc.Tags)
                    .filter((tag) => tag.Key === 'Name')
                    .first();

                if (!first) {
                    return;
                }

                return first.Value;
            }
        }

        function excludeTerminated(instancesDesc) {
            return _.filter(instancesDesc,
                (instanceDesc) =>
                instanceDesc.status !== ProviderAWSEC2.ST_TERMINATED &&
                instanceDesc.status !== ProviderAWSEC2.ST_SHUTTING_DOWN
            );
        }

        function excludeOutscope(instancesDesc) {
            return _.filter(instancesDesc,
                (instanceDesc) => instanceDesc.tag && instanceDesc.tag.indexOf(self._config.tag) === 0
            );
        }

        function convertToModel(instancesDesc) {
            return _.map(instancesDesc, (instanceDesc) => new InstanceModel(
                instanceDesc.id,
                self.name,
                convertStatus(instanceDesc.status),
                false,
                buildAddress(instanceDesc.ip),
                instanceDesc
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
                    case ProviderAWSEC2.ST_PENDING:
                    {
                        return InstanceModel.STARTING;
                    }
                    case ProviderAWSEC2.ST_RUNNING:
                    {
                        return InstanceModel.STARTED;
                    }
                    case ProviderAWSEC2.ST_STOPPED:
                    {
                        return InstanceModel.STOPPED;
                    }
                    case ProviderAWSEC2.ST_STOPPING:
                    {
                        return InstanceModel.STOPPING;
                    }
                    default:
                    {
                        winston.error('[ProviderAWSEC2] Error: Found unknown status:', status);

                        return InstanceModel.ERROR;
                    }
                }
            }
        }
    }

    createInstances(count) {
        winston.debug('[ProviderAWSEC2] createInstances: count=%d', count);
        const self = this;

        return new Promise((resolve, reject) => {
            this._ec2.describeInstances(
                {Filters: [
                    {Name: 'vpc-id', Values: [`${self._vpcid}`]},
                ]}, (errDescribe, dataDescribe) => {
                    if (errDescribe) {
                    return reject(errDescribe);
                }

                const actualCount = _(dataDescribe.Reservations)
                    .map('Instances')
                    .flatten()
                    .filter(
                    (instance) =>
                    instance.State.Name !== ProviderAWSEC2.ST_SHUTTING_DOWN &&
                    instance.State.Name !== ProviderAWSEC2.ST_TERMINATED
                )
                    .size();

                winston.debug('[ProviderAWSEC2] createInstances: actualCount=%d', actualCount);

                if (this._config.maxRunningInstances && actualCount + count > this._config.maxRunningInstances) {
                    return reject(new ScalingError(count, true));
                }

                const runParams = _.merge({}, this._config.instance, {
                    MinCount: count,
                    MaxCount: count,
                    InstanceInitiatedShutdownBehavior: 'terminate',
                    Monitoring: {
                        Enabled: false,
                    },
                });

                this._ec2.runInstances(runParams, (errParams, dataRun) => {
                    if (errParams) {
                        if (errParams.code === 'InstanceLimitExceeded') {
                            return reject(new ScalingError(count, false));
                        }

                        return reject(errParams);
                    }

                    const ids = _.map(dataRun.Instances, 'InstanceId');

                    // Need to add some delay because EC2 API is not so fast!
                    setTimeout(() => {
                        const tagsParams = {
                            Resources: ids,
                            Tags: [{
                                'Key': 'Name',
                                'Value': this._config.tag,
                            }],
                        };

                        this._ec2.createTags(tagsParams, (errTags) => {
                            if (errTags) {
                                return reject(errTags);
                            }

                            resolve();
                        });
                    }, 500);
                });
            });
        });
    }


    startInstance(model) {
        winston.debug('[ProviderAWSEC2] startInstance: model=', model.toString());

        return new Promise((resolve, reject) => {
            const params = {
                'InstanceIds': [model.providerOpts.id],
            };

            this._ec2.startInstances(params, (err) => {
                if (err) {
                    return reject(err);
                }

                resolve();
            });
        });
    }


    removeInstance(model) {
        winston.debug('[ProviderAWSEC2] removeInstance: model=', model.toString());

        return new Promise((resolve, reject) => {
            const params = {
                'InstanceIds': [model.providerOpts.id],
            };

            this._ec2.terminateInstances(params, (err) => {
                if (err) {
                    return reject(err);
                }

                resolve();
            });
        });
    }
};
