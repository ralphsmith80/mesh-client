define([
    'vendor/jquery',
    'vendor/underscore',
    'bedrock/class',
    './model',
    './fields',
    './request'
], function($, _, Class, model, fields, Request) {
    var localStorage = window.localStorage, // so jshint stops whining
        token = function(request, id) {
            return request.bundle + '-' + id;
        },

        LocalStorageGet = Request.extend({
            initiate: function(id) {
                var item = JSON.parse(localStorage.getItem(token(this, id)));
                return $.Deferred()[item? 'resolve' : 'reject'](item || {}, {status: 200});
            },
            schema: fields.FlexibleSchema()
        }),
        LocalStorageCreate = Request.extend({
            initiate: function(id, data) {
                localStorage.setItem(token(this, id), JSON.stringify(data));
                return $.Deferred().resolve({}, {status: 200});
            },
            schema: fields.FlexibleSchema()
        }),
        LocalStorageUpdate = Request.extend({
            initiate: function(id, data) {
                var t = token(this, id),
                    current = JSON.parse(localStorage.getItem(t)),
                    updated = _.reduce(data, function(memo, value, key) {
                        if (key === 'id' && value !== current.id) {
                            throw Error('attempting to update local model with inconsistent id');
                        } else {
                            memo[key] = value;
                        }
                        return memo;
                    }, current);
                localStorage.setItem(t, JSON.stringify(updated));
                return $.Deferred().resolve({}, {status: 200});
            },
            schema: fields.FlexibleSchema()
        }),
        LocalStorageDelete = Request.extend({
            initiate: function(id) {
                localStorage.removeItem(token(this, id));
                return $.Deferred().resolve({}, {status: 200});
            }
        }),
        NoopQuery = Request.extend({
            initiate: function(){
                return $.Deferred().resolve({resources:[]},{status:200});
            }
        });



    return model.Model.extend({
        __new__: function(constructor, base, prototype) {
            var params = {bundle: prototype.__bundle__};

            // call _super() so that we allocate a Manger for the resource
            // that's extending LocalModel
            this._super.apply(this, arguments);

            prototype.__requests__ = {
                get: LocalStorageGet(params),
                create: LocalStorageCreate(params),
                update: LocalStorageUpdate(params),
                "delete": LocalStorageDelete(params),
                query: NoopQuery(params)
            };
        }
    });
});
