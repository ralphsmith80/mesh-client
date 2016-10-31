define([
    'vendor/jquery',
    'vendor/underscore',
    'vendor/uuid',
    'vendor/moment',
    'bedrock/class',
    'mesh/fields'
], function($, _, uuid, moment, Class, fields) {
    var Xhr = Class.extend({
        init: function(stat, rest) {
            this.status = stat || 200;
            _.extend(this, rest);
        },
        getResponseHeader: function() { return 'application/json'; }
    });

    // we use a format for query params that's like json but not json
    function pseudoJsonToObject(pseudoJson) {
        var withoutCurlies = pseudoJson.replace(/^\{/, '').replace(/\}$/, ''),
            // split item on ',' that proceed '<key>:'
            // we do this so the arrays that are strings right now don't explode
            // e.g. "content_type__in:[11,7,1,10,2,4],volume_type__in:[Exchange,filenet,Sharepoint]"
            items = withoutCurlies.split(/,(?=\w+:)/),
            tuples = _.map(items, function(item) { return item.split(':'); });
        return _.reduce(tuples, function(memo, item) {
            var value = item[1];
            memo[item[0]] = value;
            // convert to bool if needed
            if (_.isString(value)) {
                value = value.toLowerCase();
                if (value === 'true') {
                    memo[item[0]] = true;
                } else if (value === 'false') {
                    memo[item[0]] = false;
                }
            }
            // convert to array if needed
            // this may be a real array in which case we use JSON.parse
            // or it may be a pseudo list in which case we use pseudoListToArray
            // first does it look like an array
            if (value.match(/^\[.*\]$/)) {
                try {
                    value = JSON.parse(value);
                    if (_.isArray(value)) {
                        memo[item[0]] = value;
                    }
                } catch (e) {
                    // real array converstion failed perform pseudo list conversion
                    memo[item[0]] = pseudoListToArray(value);
                }
            }
            // memo[item[0]] = item[1];
            return memo;
        }, {});
    }

    function pseudoListToArray(pseudoList) {
        return pseudoList.replace(/^\[/,'').replace(/\]$/,'').split(',');
    }

    // 'params' here is the object passed to the 'ajax' method of a request
    function filterFromParams(objects, params, attr) {
        var filter = {}, data = params.data || {},
            limit = data.limit,
            offset = data.offset;

        if (params.data && params.data.query) {
            filter = pseudoJsonToObject(params.data.query);
        }
        _.each(filter, function(value, key) {
            var split = key.split('__'), prop = split[0], op = split[1];
            if (key === 'id' || key === 'document_id' || key === 'infoset_id' ||
                key === 'is_service' || key === 'defunct') {
                objects = _.where(objects, key, value);
            } else {
                objects = _.filter(objects, function(o) {
                    if (o[prop] === null && value === null) {
                        return true;
                    }
                    if (op === 'icontains') {
                        return o[prop].toLowerCase().indexOf(value.toLowerCase()) >= 0;
                    } else if (op === 'gt') {
                        if (_.isNaN(Number(value))) {
                            return moment(o[prop] || 0)._d > moment(value)._d;
                        }
                        return Number(o[prop]) > Number(value);
                    } else if (op === 'gte') {
                        if (_.isNaN(Number(value))) {
                            return moment(o[prop] || 0)._d >= moment(value)._d;
                        }
                        return Number(o[prop]) >= Number(value);
                    } else if (op === 'lt') {
                        if (_.isNaN(Number(value))) {
                            return moment(o[prop] || 0)._d < moment(value)._d;
                        }
                        return Number(o[prop]) < Number(value);
                    } else if (op === 'lte') {
                        if (_.isNaN(Number(value))) {
                            return moment(o[prop] || 0)._d <= moment(value)._d;
                        }
                        return Number(o[prop]) <= Number(value);
                    } else if (op === 'in') {
                        if (_.isString(o[prop])) {
                            return _.contains(value, o[prop].toLowerCase());
                        }
                        return _.contains(value, o[prop]);
                    } else {
                        // just return any matching
                        try {
                            // make sure the data type matches
                            if (typeof(o[prop]) !== 'string') {
                                return o[prop].toString().indexOf(value) >= 0;
                            }
                            return o[prop].indexOf(value) >= 0;
                        } catch (e) {
                            // if you get here you may want to consider updating the key check above
                            // i.e. key === 'prop' or ensuring the 'op' is being treated approriately
                            console.warn('failed to filter on param:', prop, 'with value:', value);
                        }
                    }
                });
            }
        });
        if (offset != null) {
            objects = objects.slice(offset);
        }
        if (limit != null) {
            objects = objects.slice(0, limit);
        }

        return _.map(objects, function(o) { return $.extend(true, {}, o); });
    }

    function stripUnlessIncluded(objects, params, check) {
        var include = params.data && params.data.include?
            pseudoListToArray(params.data.include) : [];
        return _.map(objects, function(o) {
            o = $.extend(true, {}, o); // just to be safe
            return _.reduce(o, function(o, v, k) {
                if (_.indexOf(check, k) > -1) {
                    if (_.indexOf(include, k) > -1) {
                        o[k] = v;
                    }
                } else {
                    o[k] = v;
                }
                return o;
            }, {});
        });
    }

    function mockResource(name, Resource, defaultResourceFixtures, opts) {
        var hasUuid, id, defaultDelay = 0,
            delay = defaultDelay,
            fail = false,
            resourceFixtures = _.map(defaultResourceFixtures, function(f) {
                return $.extend(true, {}, f);
            }),
            defaultTotal = defaultResourceFixtures.length,
            total = resourceFixtures.length,
            reqHandlers = {};

        opts = opts || {};

        if (Resource.prototype.__schema__.id instanceof fields.UUIDField) {
            hasUuid = true;
        }

        id = resourceFixtures.length + 1;

        window[name] = Resource;

        if (Resource.prototype.__requests__.query) {
            Resource.prototype.__requests__.query.ajax = reqHandlers.query = function(params) {
                var dfd = $.Deferred(),
                    resources = [],
                    // limit = params.data.limit || resourceFixtures.length,
                    // offset = params.data.offset || 0,
                    shouldFail = fail;

                resources = filterFromParams(resourceFixtures.slice(0, total), params);
                if (opts.includeable) {
                    resources = stripUnlessIncluded(
                            resources, params, opts.includeable);
                }

                setTimeout(function() {
                    if (shouldFail) {
                        params.error({
                            getResponseHeader: function() {return '';},
                            status: 406,
                            statusText: 'didnt work'
                        });
                    } else {
                        params.success({
                            resources: resources,
                            total: total
                        }, 200, Xhr());
                    }
                }, delay);
                return dfd;
            };
        }

        if (Resource.prototype.__requests__.update) {
            Resource.prototype.__requests__.get.ajax = reqHandlers.get = function(params) {
                var obj, objects,  shouldFail = fail,
                    which = _.last(params.url.split('/'));

                if (!hasUuid) {
                    which = +which;
                }

                objects = filterFromParams(resourceFixtures, params);
                obj = _.find(objects, function(o) { return o.id === which; });
                if (opts.includeable) {
                    obj = stripUnlessIncluded([obj], params, opts.includeable)[0];
                }

                setTimeout(function() {
                    if (shouldFail) {
                        params.error(Xhr(406));
                    } else if (!obj) {
                        params.error(Xhr(404));
                    } else {
                        params.success($.extend(true, {}, obj), 200, Xhr());
                    }
                }, delay);
            };
        }

        if (Resource.prototype.__requests__.update) {
            Resource.prototype.__requests__.update.ajax = reqHandlers.update = function(params) {
                var obj, which = _.last(params.url.split('/')), shouldFail = fail;

                if (!hasUuid) {
                    which = +which;
                }

                setTimeout(function() {
                    if (shouldFail) {
                        params.error(Xhr(406));
                    } else {
                        obj = _.find(resourceFixtures, function(e) {
                            return e.id === which;
                        });
                        $.extend(obj, JSON.parse(params.data));
                        params.success({id: obj.id}, 200, Xhr());
                    }
                }, delay);
            };
        }

        if (Resource.prototype.__requests__['delete']) {
            Resource.prototype.__requests__['delete'].ajax = reqHandlers['delete'] = function(params) {
                var obj, which = _.last(params.url.split('/')), shouldFail = fail;

                if (!hasUuid) {
                    which = +which;
                }

                setTimeout(function() {
                    if (shouldFail) {
                        params.error(Xhr(406));
                    } else {
                        resourceFixtures = _.filter(resourceFixtures, function(f) {
                            return f.id !== which;
                        });
                        params.success({id: which}, 200, Xhr());
                    }
                }, delay);

            };
        }

        if (Resource.prototype.__requests__.create) {
            Resource.prototype.__requests__.create.ajax = reqHandlers.create = function(params) {
                var obj, which = _.last(params.url.split('/')), shouldFail = fail;

                setTimeout(function() {
                    if (shouldFail) {
                        params.error(Xhr(406));
                    } else {
                        resourceFixtures.push(JSON.parse(params.data));
                        total++;
                        if (hasUuid) {
                            _.last(resourceFixtures).id = uuid();
                        } else {
                            _.last(resourceFixtures).id = id++;
                        }
                        params.success({id: _.last(resourceFixtures).id}, 200, Xhr());
                    }
                }, delay);

            };
        }

        Resource.mockDelay = function(newDelay) {
            delay = newDelay == null? defaultDelay : newDelay;
            return Resource;
        };

        Resource.mockFailure = function(shouldFail) {
            fail = shouldFail == null? false : shouldFail;
            return Resource;
        };

        Resource.mockTotal = function(newTotal) {
            total = newTotal == null? defaultTotal : newTotal;
            return Resource;
        };

        Resource.mockDataChange = function(change) {
            if (change == null) {
                resourceFixtures = _.map(defaultResourceFixtures, function(f) {
                    return $.extend(true, {}, f);
                });
            } else {
                change(resourceFixtures);
            }
            return Resource;
        };

        Resource.mockGetPersistedData = function() {
            return _.map(resourceFixtures, function(f) {
                return $.extend(true, {}, f);
            });
        };

        Resource.mockWrapRequestHandler = function(req, f) {
            Resource.prototype.__requests__[req].ajax =
                _.wrap(reqHandlers[req], f);
            return Resource;
        };

        Resource.mockUnwrapRequestHandlers = function() {
            _.each(reqHandlers, function(f, req) {
                Resource.prototype.__requests__[req].ajax = f;
            });
            return Resource;
        };

        Resource.mockReset = function() {
            Resource
                .mockDelay()
                .mockTotal()
                .mockFailure()
                .mockDataChange()
                .mockUnwrapRequestHandlers()
                .models.clear();
            return Resource;
        };

        return Resource;
    }

    mockResource.Xhr = Xhr;

    return mockResource;
});

