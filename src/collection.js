define([
    'vendor/jquery',
    'bedrock/underscore',
    'bedrock/class',
    'bedrock/events'
], function($, _, Class, Eventable) {
    var extend = $.extend, intersection = _.intersection, isArray = _.isArray,
        isString = _.isString, toArray = _.toArray;

    var Query = Class.extend({
        init: function(manager, params, request) {
            if (!request || isString(request)) {
                request = manager.model.prototype._getRequest(request || 'query');
            }

            this.manager = manager;
            this.params = params || {};
            this.request = request;
        },

        clone: function(params) {
            params = extend(true, {}, this.params, params);
            return Query(this.manager, params, this.request);
        },

        count: function() {
            var self = this, params = extend({}, this.params, {total: true});
            return self.request.initiate(null, params).pipe(function(data, xhr) {
                return data.total;
            });
        },

        exclude: function() {
            var fields = toArray(arguments);
            if (fields.length > 0) {
                if (this.params.exclude) {
                    fields = intersection(fields, this.params.exclude);
                }
                this.params.exclude = fields;
            }
            return this;
        },

        execute: function(params) {
            var self = this, manager = this.manager, noclobber;
            params = params || {};
            noclobber = params.noclobber;
            return self.request.initiate(null, self.params).pipe(function(data, xhr) {
                if (!params.plain) {
                    for (var i = 0, l = data.resources.length; i < l; i++) {
                        data.resources[i] = manager.instantiate(data.resources[i], true, noclobber);
                    }
                }
                data.complete = (xhr.status === 200);
                data.status = self.request.STATUS_CODES[xhr.status];
                data.xhrStatus = xhr.status;
                return data;
            });
        },

        filter: function(params) {
            if (params) {
                if (this.params.query) {
                    extend(this.params.query, params);
                } else {
                    this.params.query = params;
                }
            }
            return this;
        },

        include: function() {
            var fields = toArray(arguments);
            if (fields.length > 0) {
                if (this.params.include) {
                    fields = intersection(fields, this.params.include);
                }
                this.params.include = fields;
            }
            return this;
        },

        limit: function(value) {
            this.params.limit = value;
            return this;
        },

        offset: function(value) {
            this.params.offset = value;
            return this;
        },

        reset: function() {
            this.params = {};
            return this;
        },

        sort: function() {
            var fields = toArray(arguments);
            if (fields.length > 0) {
                this.params.sort = fields;
            }
            return this;
        }
    });

    var Collection = Class.extend({
        init: function(manager, query) {
            if (query) {
                if (!(query instanceof Query)) {
                    query = Query(manager, query);
                }
            } else {
                query = Query(manager);
            }

            this.ids = {};
            this.manager = manager;
            this.models = [];
            this.query = query;
            this.total = null;
            this.status = null;
            this.xhrStatus = null;
            this.manager.on('change destroy add', this.notify, this);
        },

        add: function(models, idx) {
            var self = this, model, newModels = [];
            if (!isArray(models)) {
                models = [models];
            }

            if (idx == null) {
                if (self.total != null) {
                    idx = self.total;
                } else {
                    idx = self.models.length;
                }
            }

            for (var i = 0, l = models.length; i < l; i++) {
                newModels.push(model = models[i]);
                this.models.splice(idx + 1, 0, model);
                if (model.id) {
                    this.ids[model.id] = model;
                } else if (model.cid) {
                    this.ids[model.cid] = model;
                }
            }

            this.trigger('update', this, newModels);
            return this;
        },

        at: function(idx) {
            return this.models[idx] || null;
        },

        create: function(attrs, params, idx) {
            var self = this, model = this.manager.model(attrs);
            return model.save(params).pipe(function(instance) {
                self.add([instance], idx);
                return instance;
            });
        },

        get: function(id) {
            return this.ids[id] || null;
        },

        currentPage: function() {
            var self = this,
                offset = self.query.params.offset || 0,
                limit = self.query.params.limit || null,
                results;

            if (limit) {
                results = self.models.slice(offset, offset + limit);
            } else {
                results = self.models.slice(offset);
            }
            return results;
        },
        load: function(params) {
            var query, offset, limit, models, dfd, reload, total, overflow, underflow, noclobber,
                self = this;

            var prevParams,
                nextParams,
                originalOffset,
                originalLimit;

            this.trigger('load', self);
            prevParams = {
                offset: self.query.params.offset || 0,
                limit: self.query.params.limit
            };

            // pull out the reload value if it's there
            if (params) {
                // if we are forcing a reload of everything, we're doing it for a reason, so
                // we avoid attempts to load partial segments
                if(!params.reload && !params.skipContinuityCheck){
                    nextParams = {
                        offset: params.offset || self.query.params.offset || 0,
                        limit: params.limit
                    };

                    // originalOffset and originalLimit are the values of offset and limit params passed to collection.load
                    originalOffset = params.offset;
                    originalLimit = params.limit;
                }
                reload = params.reload;
                delete params.reload;
                noclobber = params.noclobber;
                delete params.noclobber;
                delete params.skipContinuityCheck;
                $.extend(true, self.query.params, params);
            }

            query = self.query.clone();
            params = $.extend(true, {}, query.params, params);
            // siq/mesh issue #10 corner case 1 and 2
            // same query
            if (!reload) {
                // shoud we use an _.isEqual for `self._lastLoad.query === self.query`?
                if (self._lastLoad && self._lastLoad.query === self.query &&
                    _.isEqual(self._lastLoad.params, params)) {
                    // check if a request is pending, if so just return the deferred and update
                    // later when resolved
                    if(self._lastLoad.dfd.state() !== 'pending') {
                        // lifted this logic from the `page cache` section below
                        models = self.models;
                        limit = params.limit;
                        offset = params.offset;
                        models = (limit) ? models.slice(offset, offset + limit) : models.slice(offset);
                        // this needs to be async to prevent loops if
                        // `load` is called from a collection update handler
                        // i.e. collection.on('update', function() { collection.load(); })
                        // yes that would be an anti-pattern so don't do it!
                        // in the real world this may happen if you create a view on collection update
                        // and in Widget::create you invoked `load` on the same collection
                        // you shouldn't do that either
                        self._lastLoad.dfd.then(function() {
                            self.trigger('update', self, models);
                        });
                    }
                    return self._lastLoad.dfd;
                }
            }

            // page cache
            if (!reload) {
                models = self.models;
                limit = params.limit;
                offset = params.offset,
                total = self.total;

                // get the cached models that fit our window
                models = (limit) ? models.slice(offset, offset + limit) : models.slice(offset);
                // overflow
                overflow = limit - offset > models.length;
                // underflow may happen on limit changes
                underflow = (offset + limit <= total) && (models.length !== limit);

                // check to make sure the models are valid and not just empty
                // remove falsy values i.e. undefined and check if the length is still the same
                if (!overflow && !underflow && models.length &&
                    _.compact(models).length === models.length) {
                    // the cache is valid
                    dfd = $.Deferred();
                    dfd.resolve(models);
                    self.trigger('update', self, models);
                    return dfd;
                }
            }

            // fresh load
            dfd = $.Deferred();
            self._lastLoad = {
                dfd: dfd,
                // siq/mesh issue #11 corner case 1
                params: $.extend(true, {}, params),
                query: self.query
            };

            // sane usage dictates that the loads be continuous
            // ex.,(0,3),(0,6),(0,10)
            if(nextParams &&
               prevParams.offset === nextParams.offset &&
               nextParams.limit > prevParams.limit ) {
                query.params.offset = params.offset = prevParams.limit;
                query.params.limit = params.limit = (nextParams.limit - prevParams.limit);
            }

            query.execute({noclobber: noclobber}).done(function(data) {
                var offset = !_.isUndefined(originalOffset)  ? originalOffset:(query.params.offset || 0),
                    limit =  !_.isUndefined(originalLimit) ? originalLimit:(query.params.limit),
                    modifiedOffset = query.params.offset || 0,
                    instance, results;

                // siq/mesh issue #10 corner case 3
                if (dfd !== self._lastLoad.dfd) {
                    // if there are multiple calls to collection::load, roll up the results of the last deferred
                    // onto the previous deferred. Ensures all deferred's are resolved. For example, in powergrid's
                    // we check if a deferred is pending or resolved
                    // If query::execute fails, the deferred is rejected
                    self._lastLoad.dfd.then(function(data) {
                        return dfd.resolve(data);
                    });
                    return;
                }
                // handle overflow case (offset + limit > total)
                if (((offset + limit) > data.total)) {
                    data.resources = data.resources.slice(0, (data.total - offset));
                }

                self.total = data.total;
                self.status = data.status;
                self.xhrStatus = data.xhrStatus;

                /* Models need to be fully replaced if a reload is called.
                   If .destroy() isn't called on a model, the manager will not be aware of a model deletion */
                if(reload) {
                    self.models = [];
                }
                for (var i = 0, l = data.resources.length; i < l; i++) {
                    instance = data.resources[i];
                    self.models[modifiedOffset + i] = instance;
                    self.ids[instance.id] = instance;
                }
                if (limit) {
                    results = self.models.slice(offset, offset + limit);
                } else {
                    results = self.models.slice(offset);
                }
                dfd.resolve(results);
                self.trigger('update', self, results);
            }).fail(function(error, xhr) {
                self.status = xhr? xhr.statusText : null;
                self.xhrStatus = xhr? xhr.status : null;
                dfd.reject(error, xhr);
                self.trigger('load-error', self, error);
                console.error('load failed', arguments);
            });

            return dfd;
        },

        notify: function(eventName, manager, model) {
            var id = model.id || model.cid,
                rest = Array.prototype.slice.call(arguments, 3);
            if (this.ids[id]) {
                if (eventName === 'destroy') {
                    this.remove(model);
                } else {
                    this.trigger.apply(this, [eventName, this, model].concat(rest));
                }
            }
            if (eventName === 'add') {
                // if there is a query then we can't be sure this model will be in
                // in the result list so `refresh()
                // otherwise we can just `add` the model which will also trigger
                // and `update` event
                if (_.isEmpty(this.query.params)) {
                    this.add(model);
                } else {
                    this.refresh();
                }
            }
        },

        refresh: function() {
            return this.load({reload: true, noclobber: true});
        },

        remove: function(models) {
            var model;
            if (!isArray(models)) {
                models = [models];
            }

            for (var i = 0, l = models.length; i < l; i++) {
                model = models[i];
                this.models.splice(_.indexOf(this.models, model), 1);
                if (model.id) {
                    delete this.ids[model.id];
                }
                if (model.cid) {
                    delete this.ids[model.cid];
                }
            }

            this.trigger('update', this, this.models);
            return this;
        },

        reset: function(query) {
            this.models = [];
            this.total = null;

            // always reset the query -- this informs .load() that the previous
            // load call is no longer fresh
            query = query == null? {} : query;

            if (!(query instanceof Query)) {
                query = Query(this.manager, query);
            }
            this.query = query;
            this.trigger('update', this);
            return this;
        },

        // short-hand for Collection.find (see below).  allows you do do stuff
        // like:
        //
        //     // get model w/ id === 1
        //     myCollection.findWhere('id', '1')
        //
        //     // get the model where 'foo' === 'foo' and age === 36
        //     myCollection.findWhere({name: 'foo', age: 36});
        //
        //     // get the model where name matches /[Ff]oo/
        //     myCollection.findWhere('name', /[Ff]oo/);
        findWhere: function(key, value) {
            var attrs = {};
            if (_.isString(key)) {
                attrs[key] = value;
            } else {
                _.extend(attrs, key);
            }
            return this.find(function(model) {
                return _.every(_.map(attrs, function(value, key) {
                    if (_.isRegExp(value)) {
                        return value.test(model[key]);
                    } else {
                        return model[key] === value;
                    }
                }), _.identity);
            });
        }
    }, {mixins: [Eventable]});

    // underscore methods
    //
    // like Backbone collections, we just mixin a bunch of underscore.js
    // methods that can be called against myCollection.models, so you can do
    // handy stuff like this:
    //
    //     myCollection.each(function(model) {
    //         model.set('_selected', false);
    //     });
    _.each(['each', 'forEach', 'map', 'reduce', 'foldl', 'inject',
            'reduceRight', 'foldr', 'find', 'detect', 'filter', 'select',
            'pluck', 'first', 'last', 'where', 'findWhere',
            'mpluck', 'mwhere', 'mfindWhere'],
            function(method) {
                Collection.prototype[method] = function() {
                    var args = Array.prototype.slice.call(arguments);
                    args.unshift(this.models);
                    return _[method].apply(this, args);
                };
            });

    return {
        Collection: Collection,
        Query: Query
    };
});
