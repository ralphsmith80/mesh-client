define([
    'vendor/underscore',
    'vendor/socket.io',
    'bedrock/class',
    'bedrock/mixins/assettable',
    'api/security/1.0/currentsubject'
], function(_, io, Class, asSettable, CurrentSubject) {

    var instance = null,
        resourceMap = {},
        socket,
        currentUser;

    function initSocket() {
        socket = io.connect(window.location.hostname);
        socket.on('connect', function() {
            console.info('connected'/*, arguments*/);
            CurrentSubject.collection().load().then(function(subjects) {
                var subject = subjects[0];
                socket.emit('loguser',{
                    userID: subject.id
                });
            });
        });
    }

    function modelAssignedToCurrentUser(model,prop){
        var modelId = model[prop || 'id'];

        return currentUser && modelId && modelId === currentUser.get('id');
    }

    function getModel(id) {
        if (!id) {
            console.warn('recieved pushed model with no id');
            return;
        }
        var registry = window.registry || {},
            manager = _.find(registry.managers, function(manager) {
                return manager.models[id];
            }) || {},
            model = _.findWhere(manager.models, {id: id});
        return model;
    }
    // function getManager(model) {
    //     var registry = window.registry || {},
    //         manager = _.find(registry.managers, function(manager) {
    //             return manager.models[model.id];
    //         });
    //     return manager;
    // }

    var SocketManager = Class.extend({
        init: function() {
            this._bindEvents();
        },
        _bindEvents: function() {
            var self = this;
            socket.on('update', function (/*arguments*/) {
                // var entity = arguments[0].entity,
                //     resource = arguments[0].resource;
                // self._updateModel(resource,entity);
                var notificationObject = arguments[0];
                self._updateModel(notificationObject);
            });
            socket.on('change', function (/*arguments*/) {
                // var entity = arguments[0].entity,
                //     resource = arguments[0].resource;
                // self._updateModel(resource,entity);
                var notificationObject = arguments[0];
                self._updateModel(notificationObject);
            });
            socket.on('delete', function (/*arguments*/) {
                // call destroy on a model
                // first set the id to null so no http request will be sent
                var entity = arguments[0].entity,
                    model = getModel(arguments[0].resource.id);
                if (!model) return;
                model.id = null;
                model.destroy();
            });
            socket.on('add', function (/*arguments*/) {
                var entity = arguments[0].entity,
                    model = arguments[0].resource,
                    manager;
                if (!model) return;
                // TODO: figure out how to get the manager from a new server model
                // remember it's from the server so it has not yet been associated with a manager
                manager.instantiate(model, true, true);
                manager.notify(model, 'add');
            });
        },
        _updateModel: function(notificationObject) {
            var resource = notificationObject.resource,
                entity = notificationObject.entity,
                id = (resource || {}).id,
                model = getModel(id),
                manager,
                responses,
                response,
                request;

            if (model) {
                try{
                    // get the response schema for unserializing in the following fallback order
                    // 1. get
                    // 2. query
                    // 3. if there is no 'get' or 'query' request then just use the first one
                    request = model.__requests__.get || model.__requests__.query ||
                        model.__requests__[_.chain(model.__requests__).keys().first().value()];
                    responses = request.responses;
                    response = responses['200'];
                    resource = response.schema.unserialize(resource, response.mimetype);
                }catch(e){
                    console.error('Error occurred while attempting to unserialize',e);
                }
                manager = model._manager;
                manager.merge(resource, model, true);
                notificationObject.resource = model;
            }
            if (instance._onModelUpdated) {
                // For some reason the eventable mixin isn't working.
                // Resorting to crude callbacks.
                instance._onModelUpdated(notificationObject, (entity === 'flux:request'));
            }
        }
    });
    asSettable.call(SocketManager.prototype, {propName: null});

    return {
        getInstance: function() {
            if (instance === null) {
                initSocket();
                window.socketmanager = instance = SocketManager();
            }
            return instance;
        }
    };
});
