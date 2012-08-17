/** vim: et:ts=4:sw=4:sts=4
 * @license RequireJS 1.0.7 Copyright (c) 2010-2012, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/jrburke/requirejs for details
 */
/*jslint strict: false, plusplus: false, sub: true */
/*global window, navigator, document, importScripts, jQuery, setTimeout, opera */

var requirejs, require, define;
(function () {
    //Change this version number for each release.
    var version = "1.0.7",
        commentRegExp = /(\/\*([\s\S]*?)\*\/|([^:]|^)\/\/(.*)$)/mg,
        cjsRequireRegExp = /require\(\s*["']([^'"\s]+)["']\s*\)/g,
        currDirRegExp = /^\.\//,
        jsSuffixRegExp = /\.js$/,
        ostring = Object.prototype.toString,
        ap = Array.prototype,
        aps = ap.slice,
        apsp = ap.splice,
        isBrowser = !!(typeof window !== "undefined" && navigator && document),
        isWebWorker = !isBrowser && typeof importScripts !== "undefined",
        //PS3 indicates loaded and complete, but need to wait for complete
        //specifically. Sequence is "loading", "loaded", execution,
        // then "complete". The UA check is unfortunate, but not sure how
        //to feature test w/o causing perf issues.
        readyRegExp = isBrowser && navigator.platform === 'PLAYSTATION 3' ?
                      /^complete$/ : /^(complete|loaded)$/,
        defContextName = "_",
        //Oh the tragedy, detecting opera. See the usage of isOpera for reason.
        isOpera = typeof opera !== "undefined" && opera.toString() === "[object Opera]",
        empty = {},
        contexts = {},
        globalDefQueue = [],
        interactiveScript = null,
        checkLoadedDepth = 0,
        useInteractive = false,
        reservedDependencies = {
            require: true,
            module: true,
            exports: true
        },
        req, cfg = {}, currentlyAddingScript, s, head, baseElement, scripts, script,
        src, subPath, mainScript, dataMain, globalI, ctx, jQueryCheck, checkLoadedTimeoutId;

    function isFunction(it) {
        return ostring.call(it) === "[object Function]";
    }

    function isArray(it) {
        return ostring.call(it) === "[object Array]";
    }

    /**
     * Simple function to mix in properties from source into target,
     * but only if target does not already have a property of the same name.
     * This is not robust in IE for transferring methods that match
     * Object.prototype names, but the uses of mixin here seem unlikely to
     * trigger a problem related to that.
     */
    function mixin(target, source, force) {
        for (var prop in source) {
            if (!(prop in empty) && (!(prop in target) || force)) {
                target[prop] = source[prop];
            }
        }
        return req;
    }

    /**
     * Constructs an error with a pointer to an URL with more information.
     * @param {String} id the error ID that maps to an ID on a web page.
     * @param {String} message human readable error.
     * @param {Error} [err] the original error, if there is one.
     *
     * @returns {Error}
     */
    function makeError(id, msg, err) {
        var e = new Error(msg + '\nhttp://requirejs.org/docs/errors.html#' + id);
        if (err) {
            e.originalError = err;
        }
        return e;
    }

    /**
     * Used to set up package paths from a packagePaths or packages config object.
     * @param {Object} pkgs the object to store the new package config
     * @param {Array} currentPackages an array of packages to configure
     * @param {String} [dir] a prefix dir to use.
     */
    function configurePackageDir(pkgs, currentPackages, dir) {
        var i, location, pkgObj;

        for (i = 0; (pkgObj = currentPackages[i]); i++) {
            pkgObj = typeof pkgObj === "string" ? { name: pkgObj } : pkgObj;
            location = pkgObj.location;

            //Add dir to the path, but avoid paths that start with a slash
            //or have a colon (indicates a protocol)
            if (dir && (!location || (location.indexOf("/") !== 0 && location.indexOf(":") === -1))) {
                location = dir + "/" + (location || pkgObj.name);
            }

            //Create a brand new object on pkgs, since currentPackages can
            //be passed in again, and config.pkgs is the internal transformed
            //state for all package configs.
            pkgs[pkgObj.name] = {
                name: pkgObj.name,
                location: location || pkgObj.name,
                //Remove leading dot in main, so main paths are normalized,
                //and remove any trailing .js, since different package
                //envs have different conventions: some use a module name,
                //some use a file name.
                main: (pkgObj.main || "main")
                      .replace(currDirRegExp, '')
                      .replace(jsSuffixRegExp, '')
            };
        }
    }

    /**
     * jQuery 1.4.3-1.5.x use a readyWait/ready() pairing to hold DOM
     * ready callbacks, but jQuery 1.6 supports a holdReady() API instead.
     * At some point remove the readyWait/ready() support and just stick
     * with using holdReady.
     */
    function jQueryHoldReady($, shouldHold) {
        if ($.holdReady) {
            $.holdReady(shouldHold);
        } else if (shouldHold) {
            $.readyWait += 1;
        } else {
            $.ready(true);
        }
    }

    if (typeof define !== "undefined") {
        //If a define is already in play via another AMD loader,
        //do not overwrite.
        return;
    }

    if (typeof requirejs !== "undefined") {
        if (isFunction(requirejs)) {
            //Do not overwrite and existing requirejs instance.
            return;
        } else {
            cfg = requirejs;
            requirejs = undefined;
        }
    }

    //Allow for a require config object
    if (typeof require !== "undefined" && !isFunction(require)) {
        //assume it is a config object.
        cfg = require;
        require = undefined;
    }

    /**
     * Creates a new context for use in require and define calls.
     * Handle most of the heavy lifting. Do not want to use an object
     * with prototype here to avoid using "this" in require, in case it
     * needs to be used in more super secure envs that do not want this.
     * Also there should not be that many contexts in the page. Usually just
     * one for the default context, but could be extra for multiversion cases
     * or if a package needs a special context for a dependency that conflicts
     * with the standard context.
     */
    function newContext(contextName) {
        var context, resume,
            config = {
                waitSeconds: 7,
                baseUrl: "./",
                paths: {},
                pkgs: {},
                catchError: {}
            },
            defQueue = [],
            specified = {
                "require": true,
                "exports": true,
                "module": true
            },
            urlMap = {},
            defined = {},
            loaded = {},
            waiting = {},
            waitAry = [],
            urlFetched = {},
            managerCounter = 0,
            managerCallbacks = {},
            plugins = {},
            //Used to indicate which modules in a build scenario
            //need to be full executed.
            needFullExec = {},
            fullExec = {},
            resumeDepth = 0;

        /**
         * Trims the . and .. from an array of path segments.
         * It will keep a leading path segment if a .. will become
         * the first path segment, to help with module name lookups,
         * which act like paths, but can be remapped. But the end result,
         * all paths that use this function should look normalized.
         * NOTE: this method MODIFIES the input array.
         * @param {Array} ary the array of path segments.
         */
        function trimDots(ary) {
            var i, part;
            for (i = 0; (part = ary[i]); i++) {
                if (part === ".") {
                    ary.splice(i, 1);
                    i -= 1;
                } else if (part === "..") {
                    if (i === 1 && (ary[2] === '..' || ary[0] === '..')) {
                        //End of the line. Keep at least one non-dot
                        //path segment at the front so it can be mapped
                        //correctly to disk. Otherwise, there is likely
                        //no path mapping for a path starting with '..'.
                        //This can still fail, but catches the most reasonable
                        //uses of ..
                        break;
                    } else if (i > 0) {
                        ary.splice(i - 1, 2);
                        i -= 2;
                    }
                }
            }
        }

        /**
         * Given a relative module name, like ./something, normalize it to
         * a real name that can be mapped to a path.
         * @param {String} name the relative name
         * @param {String} baseName a real name that the name arg is relative
         * to.
         * @returns {String} normalized name
         */
        function normalize(name, baseName) {
            var pkgName, pkgConfig;

            //Adjust any relative paths.
            if (name && name.charAt(0) === ".") {
                //If have a base name, try to normalize against it,
                //otherwise, assume it is a top-level require that will
                //be relative to baseUrl in the end.
                if (baseName) {
                    if (config.pkgs[baseName]) {
                        //If the baseName is a package name, then just treat it as one
                        //name to concat the name with.
                        baseName = [baseName];
                    } else {
                        //Convert baseName to array, and lop off the last part,
                        //so that . matches that "directory" and not name of the baseName's
                        //module. For instance, baseName of "one/two/three", maps to
                        //"one/two/three.js", but we want the directory, "one/two" for
                        //this normalization.
                        baseName = baseName.split("/");
                        baseName = baseName.slice(0, baseName.length - 1);
                    }

                    name = baseName.concat(name.split("/"));
                    trimDots(name);

                    //Some use of packages may use a . path to reference the
                    //"main" module name, so normalize for that.
                    pkgConfig = config.pkgs[(pkgName = name[0])];
                    name = name.join("/");
                    if (pkgConfig && name === pkgName + '/' + pkgConfig.main) {
                        name = pkgName;
                    }
                } else if (name.indexOf("./") === 0) {
                    // No baseName, so this is ID is resolved relative
                    // to baseUrl, pull off the leading dot.
                    name = name.substring(2);
                }
            }
            return name;
        }

        /**
         * Creates a module mapping that includes plugin prefix, module
         * name, and path. If parentModuleMap is provided it will
         * also normalize the name via require.normalize()
         *
         * @param {String} name the module name
         * @param {String} [parentModuleMap] parent module map
         * for the module name, used to resolve relative names.
         *
         * @returns {Object}
         */
        function makeModuleMap(name, parentModuleMap) {
            var index = name ? name.indexOf("!") : -1,
                prefix = null,
                parentName = parentModuleMap ? parentModuleMap.name : null,
                originalName = name,
                normalizedName, url, pluginModule;

            if (index !== -1) {
                prefix = name.substring(0, index);
                name = name.substring(index + 1, name.length);
            }

            if (prefix) {
                prefix = normalize(prefix, parentName);
            }

            //Account for relative paths if there is a base name.
            if (name) {
                if (prefix) {
                    pluginModule = defined[prefix];
                    if (pluginModule && pluginModule.normalize) {
                        //Plugin is loaded, use its normalize method.
                        normalizedName = pluginModule.normalize(name, function (name) {
                            return normalize(name, parentName);
                        });
                    } else {
                        normalizedName = normalize(name, parentName);
                    }
                } else {
                    //A regular module.
                    normalizedName = normalize(name, parentName);

                    url = urlMap[normalizedName];
                    if (!url) {
                        //Calculate url for the module, if it has a name.
                        //Use name here since nameToUrl also calls normalize,
                        //and for relative names that are outside the baseUrl
                        //this causes havoc. Was thinking of just removing
                        //parentModuleMap to avoid extra normalization, but
                        //normalize() still does a dot removal because of
                        //issue #142, so just pass in name here and redo
                        //the normalization. Paths outside baseUrl are just
                        //messy to support.
                        url = context.nameToUrl(name, null, parentModuleMap);

                        //Store the URL mapping for later.
                        urlMap[normalizedName] = url;
                    }
                }
            }

            return {
                prefix: prefix,
                name: normalizedName,
                parentMap: parentModuleMap,
                url: url,
                originalName: originalName,
                fullName: prefix ? prefix + "!" + (normalizedName || '') : normalizedName
            };
        }

        /**
         * Determine if priority loading is done. If so clear the priorityWait
         */
        function isPriorityDone() {
            var priorityDone = true,
                priorityWait = config.priorityWait,
                priorityName, i;
            if (priorityWait) {
                for (i = 0; (priorityName = priorityWait[i]); i++) {
                    if (!loaded[priorityName]) {
                        priorityDone = false;
                        break;
                    }
                }
                if (priorityDone) {
                    delete config.priorityWait;
                }
            }
            return priorityDone;
        }

        function makeContextModuleFunc(func, relModuleMap, enableBuildCallback) {
            return function () {
                //A version of a require function that passes a moduleName
                //value for items that may need to
                //look up paths relative to the moduleName
                var args = aps.call(arguments, 0), lastArg;
                if (enableBuildCallback &&
                    isFunction((lastArg = args[args.length - 1]))) {
                    lastArg.__requireJsBuild = true;
                }
                args.push(relModuleMap);
                return func.apply(null, args);
            };
        }

        /**
         * Helper function that creates a require function object to give to
         * modules that ask for it as a dependency. It needs to be specific
         * per module because of the implication of path mappings that may
         * need to be relative to the module name.
         */
        function makeRequire(relModuleMap, enableBuildCallback, altRequire) {
            var modRequire = makeContextModuleFunc(altRequire || context.require, relModuleMap, enableBuildCallback);

            mixin(modRequire, {
                nameToUrl: makeContextModuleFunc(context.nameToUrl, relModuleMap),
                toUrl: makeContextModuleFunc(context.toUrl, relModuleMap),
                defined: makeContextModuleFunc(context.requireDefined, relModuleMap),
                specified: makeContextModuleFunc(context.requireSpecified, relModuleMap),
                isBrowser: req.isBrowser
            });
            return modRequire;
        }

        /*
         * Queues a dependency for checking after the loader is out of a
         * "paused" state, for example while a script file is being loaded
         * in the browser, where it may have many modules defined in it.
         */
        function queueDependency(manager) {
            context.paused.push(manager);
        }

        function execManager(manager) {
            var i, ret, err, errFile, errModuleTree,
                cb = manager.callback,
                map = manager.map,
                fullName = map.fullName,
                args = manager.deps,
                listeners = manager.listeners,
                cjsModule;

            //Call the callback to define the module, if necessary.
            if (cb && isFunction(cb)) {
                if (config.catchError.define) {
                    try {
                        ret = req.execCb(fullName, manager.callback, args, defined[fullName]);
                    } catch (e) {
                        err = e;
                    }
                } else {
                    ret = req.execCb(fullName, manager.callback, args, defined[fullName]);
                }

                if (fullName) {
                    //If setting exports via "module" is in play,
                    //favor that over return value and exports. After that,
                    //favor a non-undefined return value over exports use.
                    cjsModule = manager.cjsModule;
                    if (cjsModule &&
                        cjsModule.exports !== undefined &&
                        //Make sure it is not already the exports value
                        cjsModule.exports !== defined[fullName]) {
                        ret = defined[fullName] = manager.cjsModule.exports;
                    } else if (ret === undefined && manager.usingExports) {
                        //exports already set the defined value.
                        ret = defined[fullName];
                    } else {
                        //Use the return value from the function.
                        defined[fullName] = ret;
                        //If this module needed full execution in a build
                        //environment, mark that now.
                        if (needFullExec[fullName]) {
                            fullExec[fullName] = true;
                        }
                    }
                }
            } else if (fullName) {
                //May just be an object definition for the module. Only
                //worry about defining if have a module name.
                ret = defined[fullName] = cb;

                //If this module needed full execution in a build
                //environment, mark that now.
                if (needFullExec[fullName]) {
                    fullExec[fullName] = true;
                }
            }

            //Clean up waiting. Do this before error calls, and before
            //calling back listeners, so that bookkeeping is correct
            //in the event of an error and error is reported in correct order,
            //since the listeners will likely have errors if the
            //onError function does not throw.
            if (waiting[manager.id]) {
                delete waiting[manager.id];
                manager.isDone = true;
                context.waitCount -= 1;
                if (context.waitCount === 0) {
                    //Clear the wait array used for cycles.
                    waitAry = [];
                }
            }

            //Do not need to track manager callback now that it is defined.
            delete managerCallbacks[fullName];

            //Allow instrumentation like the optimizer to know the order
            //of modules executed and their dependencies.
            if (req.onResourceLoad && !manager.placeholder) {
                req.onResourceLoad(context, map, manager.depArray);
            }

            if (err) {
                errFile = (fullName ? makeModuleMap(fullName).url : '') ||
                           err.fileName || err.sourceURL;
                errModuleTree = err.moduleTree;
                err = makeError('defineerror', 'Error evaluating ' +
                                'module "' + fullName + '" at location "' +
                                errFile + '":\n' +
                                err + '\nfileName:' + errFile +
                                '\nlineNumber: ' + (err.lineNumber || err.line), err);
                err.moduleName = fullName;
                err.moduleTree = errModuleTree;
                return req.onError(err);
            }

            //Let listeners know of this manager's value.
            for (i = 0; (cb = listeners[i]); i++) {
                cb(ret);
            }

            return undefined;
        }

        /**
         * Helper that creates a callack function that is called when a dependency
         * is ready, and sets the i-th dependency for the manager as the
         * value passed to the callback generated by this function.
         */
        function makeArgCallback(manager, i) {
            return function (value) {
                //Only do the work if it has not been done
                //already for a dependency. Cycle breaking
                //logic in forceExec could mean this function
                //is called more than once for a given dependency.
                if (!manager.depDone[i]) {
                    manager.depDone[i] = true;
                    manager.deps[i] = value;
                    manager.depCount -= 1;
                    if (!manager.depCount) {
                        //All done, execute!
                        execManager(manager);
                    }
                }
            };
        }

        function callPlugin(pluginName, depManager) {
            var map = depManager.map,
                fullName = map.fullName,
                name = map.name,
                plugin = plugins[pluginName] ||
                        (plugins[pluginName] = defined[pluginName]),
                load;

            //No need to continue if the manager is already
            //in the process of loading.
            if (depManager.loading) {
                return;
            }
            depManager.loading = true;

            load = function (ret) {
                depManager.callback = function () {
                    return ret;
                };
                execManager(depManager);

                loaded[depManager.id] = true;

                //The loading of this plugin
                //might have placed other things
                //in the paused queue. In particular,
                //a loader plugin that depends on
                //a different plugin loaded resource.
                resume();
            };

            //Allow plugins to load other code without having to know the
            //context or how to "complete" the load.
            load.fromText = function (moduleName, text) {
                /*jslint evil: true */
                var hasInteractive = useInteractive;

                //Indicate a the module is in process of loading.
                loaded[moduleName] = false;
                context.scriptCount += 1;

                //Indicate this is not a "real" module, so do not track it
                //for builds, it does not map to a real file.
                context.fake[moduleName] = true;

                //Turn off interactive script matching for IE for any define
                //calls in the text, then turn it back on at the end.
                if (hasInteractive) {
                    useInteractive = false;
                }

                req.exec(text);

                if (hasInteractive) {
                    useInteractive = true;
                }

                //Support anonymous modules.
                context.completeLoad(moduleName);
            };

            //No need to continue if the plugin value has already been
            //defined by a build.
            if (fullName in defined) {
                load(defined[fullName]);
            } else {
                //Use parentName here since the plugin's name is not reliable,
                //could be some weird string with no path that actually wants to
                //reference the parentName's path.
                plugin.load(name, makeRequire(map.parentMap, true, function (deps, cb) {
                    var moduleDeps = [],
                        i, dep, depMap;
                    //Convert deps to full names and hold on to them
                    //for reference later, when figuring out if they
                    //are blocked by a circular dependency.
                    for (i = 0; (dep = deps[i]); i++) {
                        depMap = makeModuleMap(dep, map.parentMap);
                        deps[i] = depMap.fullName;
                        if (!depMap.prefix) {
                            moduleDeps.push(deps[i]);
                        }
                    }
                    depManager.moduleDeps = (depManager.moduleDeps || []).concat(moduleDeps);
                    return context.require(deps, cb);
                }), load, config);
            }
        }

        /**
         * Adds the manager to the waiting queue. Only fully
         * resolved items should be in the waiting queue.
         */
        function addWait(manager) {
            if (!waiting[manager.id]) {
                waiting[manager.id] = manager;
                waitAry.push(manager);
                context.waitCount += 1;
            }
        }

        /**
         * Function added to every manager object. Created out here
         * to avoid new function creation for each manager instance.
         */
        function managerAdd(cb) {
            this.listeners.push(cb);
        }

        function getManager(map, shouldQueue) {
            var fullName = map.fullName,
                prefix = map.prefix,
                plugin = prefix ? plugins[prefix] ||
                                (plugins[prefix] = defined[prefix]) : null,
                manager, created, pluginManager, prefixMap;

            if (fullName) {
                manager = managerCallbacks[fullName];
            }

            if (!manager) {
                created = true;
                manager = {
                    //ID is just the full name, but if it is a plugin resource
                    //for a plugin that has not been loaded,
                    //then add an ID counter to it.
                    id: (prefix && !plugin ?
                        (managerCounter++) + '__p@:' : '') +
                        (fullName || '__r@' + (managerCounter++)),
                    map: map,
                    depCount: 0,
                    depDone: [],
                    depCallbacks: [],
                    deps: [],
                    listeners: [],
                    add: managerAdd
                };

                specified[manager.id] = true;

                //Only track the manager/reuse it if this is a non-plugin
                //resource. Also only track plugin resources once
                //the plugin has been loaded, and so the fullName is the
                //true normalized value.
                if (fullName && (!prefix || plugins[prefix])) {
                    managerCallbacks[fullName] = manager;
                }
            }

            //If there is a plugin needed, but it is not loaded,
            //first load the plugin, then continue on.
            if (prefix && !plugin) {
                prefixMap = makeModuleMap(prefix);

                //Clear out defined and urlFetched if the plugin was previously
                //loaded/defined, but not as full module (as in a build
                //situation). However, only do this work if the plugin is in
                //defined but does not have a module export value.
                if (prefix in defined && !defined[prefix]) {
                    delete defined[prefix];
                    delete urlFetched[prefixMap.url];
                }

                pluginManager = getManager(prefixMap, true);
                pluginManager.add(function (plugin) {
                    //Create a new manager for the normalized
                    //resource ID and have it call this manager when
                    //done.
                    var newMap = makeModuleMap(map.originalName, map.parentMap),
                        normalizedManager = getManager(newMap, true);

                    //Indicate this manager is a placeholder for the real,
                    //normalized thing. Important for when trying to map
                    //modules and dependencies, for instance, in a build.
                    manager.placeholder = true;

                    normalizedManager.add(function (resource) {
                        manager.callback = function () {
                            return resource;
                        };
                        execManager(manager);
                    });
                });
            } else if (created && shouldQueue) {
                //Indicate the resource is not loaded yet if it is to be
                //queued.
                loaded[manager.id] = false;
                queueDependency(manager);
                addWait(manager);
            }

            return manager;
        }

        function main(inName, depArray, callback, relModuleMap) {
            var moduleMap = makeModuleMap(inName, relModuleMap),
                name = moduleMap.name,
                fullName = moduleMap.fullName,
                manager = getManager(moduleMap),
                id = manager.id,
                deps = manager.deps,
                i, depArg, depName, depPrefix, cjsMod;

            if (fullName) {
                //If module already defined for context, or already loaded,
                //then leave. Also leave if jQuery is registering but it does
                //not match the desired version number in the config.
                if (fullName in defined || loaded[id] === true ||
                    (fullName === "jquery" && config.jQuery &&
                     config.jQuery !== callback().fn.jquery)) {
                    return;
                }

                //Set specified/loaded here for modules that are also loaded
                //as part of a layer, where onScriptLoad is not fired
                //for those cases. Do this after the inline define and
                //dependency tracing is done.
                specified[id] = true;
                loaded[id] = true;

                //If module is jQuery set up delaying its dom ready listeners.
                if (fullName === "jquery" && callback) {
                    jQueryCheck(callback());
                }
            }

            //Attach real depArray and callback to the manager. Do this
            //only if the module has not been defined already, so do this after
            //the fullName checks above. IE can call main() more than once
            //for a module.
            manager.depArray = depArray;
            manager.callback = callback;

            //Add the dependencies to the deps field, and register for callbacks
            //on the dependencies.
            for (i = 0; i < depArray.length; i++) {
                depArg = depArray[i];
                //There could be cases like in IE, where a trailing comma will
                //introduce a null dependency, so only treat a real dependency
                //value as a dependency.
                if (depArg) {
                    //Split the dependency name into plugin and name parts
                    depArg = makeModuleMap(depArg, (name ? moduleMap : relModuleMap));
                    depName = depArg.fullName;
                    depPrefix = depArg.prefix;

                    //Fix the name in depArray to be just the name, since
                    //that is how it will be called back later.
                    depArray[i] = depName;

                    //Fast path CommonJS standard dependencies.
                    if (depName === "require") {
                        deps[i] = makeRequire(moduleMap);
                    } else if (depName === "exports") {
                        //CommonJS module spec 1.1
                        deps[i] = defined[fullName] = {};
                        manager.usingExports = true;
                    } else if (depName === "module") {
                        //CommonJS module spec 1.1
                        manager.cjsModule = cjsMod = deps[i] = {
                            id: name,
                            uri: name ? context.nameToUrl(name, null, relModuleMap) : undefined,
                            exports: defined[fullName]
                        };
                    } else if (depName in defined && !(depName in waiting) &&
                               (!(fullName in needFullExec) ||
                                (fullName in needFullExec && fullExec[depName]))) {
                        //Module already defined, and not in a build situation
                        //where the module is a something that needs full
                        //execution and this dependency has not been fully
                        //executed. See r.js's requirePatch.js for more info
                        //on fullExec.
                        deps[i] = defined[depName];
                    } else {
                        //Mark this dependency as needing full exec if
                        //the current module needs full exec.
                        if (fullName in needFullExec) {
                            needFullExec[depName] = true;
                            //Reset state so fully executed code will get
                            //picked up correctly.
                            delete defined[depName];
                            urlFetched[depArg.url] = false;
                        }

                        //Either a resource that is not loaded yet, or a plugin
                        //resource for either a plugin that has not
                        //loaded yet.
                        manager.depCount += 1;
                        manager.depCallbacks[i] = makeArgCallback(manager, i);
                        getManager(depArg, true).add(manager.depCallbacks[i]);
                    }
                }
            }

            //Do not bother tracking the manager if it is all done.
            if (!manager.depCount) {
                //All done, execute!
                execManager(manager);
            } else {
                addWait(manager);
            }
        }

        /**
         * Convenience method to call main for a define call that was put on
         * hold in the defQueue.
         */
        function callDefMain(args) {
            main.apply(null, args);
        }

        /**
         * jQuery 1.4.3+ supports ways to hold off calling
         * calling jQuery ready callbacks until all scripts are loaded. Be sure
         * to track it if the capability exists.. Also, since jQuery 1.4.3 does
         * not register as a module, need to do some global inference checking.
         * Even if it does register as a module, not guaranteed to be the precise
         * name of the global. If a jQuery is tracked for this context, then go
         * ahead and register it as a module too, if not already in process.
         */
        jQueryCheck = function (jqCandidate) {
            if (!context.jQuery) {
                var $ = jqCandidate || (typeof jQuery !== "undefined" ? jQuery : null);

                if ($) {
                    //If a specific version of jQuery is wanted, make sure to only
                    //use this jQuery if it matches.
                    if (config.jQuery && $.fn.jquery !== config.jQuery) {
                        return;
                    }

                    if ("holdReady" in $ || "readyWait" in $) {
                        context.jQuery = $;

                        //Manually create a "jquery" module entry if not one already
                        //or in process. Note this could trigger an attempt at
                        //a second jQuery registration, but does no harm since
                        //the first one wins, and it is the same value anyway.
                        callDefMain(["jquery", [], function () {
                            return jQuery;
                        }]);

                        //Ask jQuery to hold DOM ready callbacks.
                        if (context.scriptCount) {
                            jQueryHoldReady($, true);
                            context.jQueryIncremented = true;
                        }
                    }
                }
            }
        };

        function findCycle(manager, traced) {
            var fullName = manager.map.fullName,
                depArray = manager.depArray,
                fullyLoaded = true,
                i, depName, depManager, result;

            if (manager.isDone || !fullName || !loaded[fullName]) {
                return result;
            }

            //Found the cycle.
            if (traced[fullName]) {
                return manager;
            }

            traced[fullName] = true;

            //Trace through the dependencies.
            if (depArray) {
                for (i = 0; i < depArray.length; i++) {
                    //Some array members may be null, like if a trailing comma
                    //IE, so do the explicit [i] access and check if it has a value.
                    depName = depArray[i];
                    if (!loaded[depName] && !reservedDependencies[depName]) {
                        fullyLoaded = false;
                        break;
                    }
                    depManager = waiting[depName];
                    if (depManager && !depManager.isDone && loaded[depName]) {
                        result = findCycle(depManager, traced);
                        if (result) {
                            break;
                        }
                    }
                }
                if (!fullyLoaded) {
                    //Discard the cycle that was found, since it cannot
                    //be forced yet. Also clear this module from traced.
                    result = undefined;
                    delete traced[fullName];
                }
            }

            return result;
        }

        function forceExec(manager, traced) {
            var fullName = manager.map.fullName,
                depArray = manager.depArray,
                i, depName, depManager, prefix, prefixManager, value;


            if (manager.isDone || !fullName || !loaded[fullName]) {
                return undefined;
            }

            if (fullName) {
                if (traced[fullName]) {
                    return defined[fullName];
                }

                traced[fullName] = true;
            }

            //Trace through the dependencies.
            if (depArray) {
                for (i = 0; i < depArray.length; i++) {
                    //Some array members may be null, like if a trailing comma
                    //IE, so do the explicit [i] access and check if it has a value.
                    depName = depArray[i];
                    if (depName) {
                        //First, make sure if it is a plugin resource that the
                        //plugin is not blocked.
                        prefix = makeModuleMap(depName).prefix;
                        if (prefix && (prefixManager = waiting[prefix])) {
                            forceExec(prefixManager, traced);
                        }
                        depManager = waiting[depName];
                        if (depManager && !depManager.isDone && loaded[depName]) {
                            value = forceExec(depManager, traced);
                            manager.depCallbacks[i](value);
                        }
                    }
                }
            }

            return defined[fullName];
        }

        /**
         * Checks if all modules for a context are loaded, and if so, evaluates the
         * new ones in right dependency order.
         *
         * @private
         */
        function checkLoaded() {
            var waitInterval = config.waitSeconds * 1000,
                //It is possible to disable the wait interval by using waitSeconds of 0.
                expired = waitInterval && (context.startTime + waitInterval) < new Date().getTime(),
                noLoads = "", hasLoadedProp = false, stillLoading = false,
                cycleDeps = [],
                i, prop, err, manager, cycleManager, moduleDeps;

            //If there are items still in the paused queue processing wait.
            //This is particularly important in the sync case where each paused
            //item is processed right away but there may be more waiting.
            if (context.pausedCount > 0) {
                return undefined;
            }

            //Determine if priority loading is done. If so clear the priority. If
            //not, then do not check
            if (config.priorityWait) {
                if (isPriorityDone()) {
                    //Call resume, since it could have
                    //some waiting dependencies to trace.
                    resume();
                } else {
                    return undefined;
                }
            }

            //See if anything is still in flight.
            for (prop in loaded) {
                if (!(prop in empty)) {
                    hasLoadedProp = true;
                    if (!loaded[prop]) {
                        if (expired) {
                            noLoads += prop + " ";
                        } else {
                            stillLoading = true;
                            if (prop.indexOf('!') === -1) {
                                //No reason to keep looking for unfinished
                                //loading. If the only stillLoading is a
                                //plugin resource though, keep going,
                                //because it may be that a plugin resource
                                //is waiting on a non-plugin cycle.
                                cycleDeps = [];
                                break;
                            } else {
                                moduleDeps = managerCallbacks[prop] && managerCallbacks[prop].moduleDeps;
                                if (moduleDeps) {
                                    cycleDeps.push.apply(cycleDeps, moduleDeps);
                                }
                            }
                        }
                    }
                }
            }

            //Check for exit conditions.
            if (!hasLoadedProp && !context.waitCount) {
                //If the loaded object had no items, then the rest of
                //the work below does not need to be done.
                return undefined;
            }
            if (expired && noLoads) {
                //If wait time expired, throw error of unloaded modules.
                err = makeError("timeout", "Load timeout for modules: " + noLoads);
                err.requireType = "timeout";
                err.requireModules = noLoads;
                err.contextName = context.contextName;
                return req.onError(err);
            }

            //If still loading but a plugin is waiting on a regular module cycle
            //break the cycle.
            if (stillLoading && cycleDeps.length) {
                for (i = 0; (manager = waiting[cycleDeps[i]]); i++) {
                    if ((cycleManager = findCycle(manager, {}))) {
                        forceExec(cycleManager, {});
                        break;
                    }
                }

            }

            //If still waiting on loads, and the waiting load is something
            //other than a plugin resource, or there are still outstanding
            //scripts, then just try back later.
            if (!expired && (stillLoading || context.scriptCount)) {
                //Something is still waiting to load. Wait for it, but only
                //if a timeout is not already in effect.
                if ((isBrowser || isWebWorker) && !checkLoadedTimeoutId) {
                    checkLoadedTimeoutId = setTimeout(function () {
                        checkLoadedTimeoutId = 0;
                        checkLoaded();
                    }, 50);
                }
                return undefined;
            }

            //If still have items in the waiting cue, but all modules have
            //been loaded, then it means there are some circular dependencies
            //that need to be broken.
            //However, as a waiting thing is fired, then it can add items to
            //the waiting cue, and those items should not be fired yet, so
            //make sure to redo the checkLoaded call after breaking a single
            //cycle, if nothing else loaded then this logic will pick it up
            //again.
            if (context.waitCount) {
                //Cycle through the waitAry, and call items in sequence.
                for (i = 0; (manager = waitAry[i]); i++) {
                    forceExec(manager, {});
                }

                //If anything got placed in the paused queue, run it down.
                if (context.paused.length) {
                    resume();
                }

                //Only allow this recursion to a certain depth. Only
                //triggered by errors in calling a module in which its
                //modules waiting on it cannot finish loading, or some circular
                //dependencies that then may add more dependencies.
                //The value of 5 is a bit arbitrary. Hopefully just one extra
                //pass, or two for the case of circular dependencies generating
                //more work that gets resolved in the sync node case.
                if (checkLoadedDepth < 5) {
                    checkLoadedDepth += 1;
                    checkLoaded();
                }
            }

            checkLoadedDepth = 0;

            //Check for DOM ready, and nothing is waiting across contexts.
            req.checkReadyState();

            return undefined;
        }

        /**
         * Resumes tracing of dependencies and then checks if everything is loaded.
         */
        resume = function () {
            var manager, map, url, i, p, args, fullName;

            //Any defined modules in the global queue, intake them now.
            context.takeGlobalQueue();

            resumeDepth += 1;

            if (context.scriptCount <= 0) {
                //Synchronous envs will push the number below zero with the
                //decrement above, be sure to set it back to zero for good measure.
                //require() calls that also do not end up loading scripts could
                //push the number negative too.
                context.scriptCount = 0;
            }

            //Make sure any remaining defQueue items get properly processed.
            while (defQueue.length) {
                args = defQueue.shift();
                if (args[0] === null) {
                    return req.onError(makeError('mismatch', 'Mismatched anonymous define() module: ' + args[args.length - 1]));
                } else {
                    callDefMain(args);
                }
            }

            //Skip the resume of paused dependencies
            //if current context is in priority wait.
            if (!config.priorityWait || isPriorityDone()) {
                while (context.paused.length) {
                    p = context.paused;
                    context.pausedCount += p.length;
                    //Reset paused list
                    context.paused = [];

                    for (i = 0; (manager = p[i]); i++) {
                        map = manager.map;
                        url = map.url;
                        fullName = map.fullName;

                        //If the manager is for a plugin managed resource,
                        //ask the plugin to load it now.
                        if (map.prefix) {
                            callPlugin(map.prefix, manager);
                        } else {
                            //Regular dependency.
                            if (!urlFetched[url] && !loaded[fullName]) {
                                req.load(context, fullName, url);

                                //Mark the URL as fetched, but only if it is
                                //not an empty: URL, used by the optimizer.
                                //In that case we need to be sure to call
                                //load() for each module that is mapped to
                                //empty: so that dependencies are satisfied
                                //correctly.
                                if (url.indexOf('empty:') !== 0) {
                                    urlFetched[url] = true;
                                }
                            }
                        }
                    }

                    //Move the start time for timeout forward.
                    context.startTime = (new Date()).getTime();
                    context.pausedCount -= p.length;
                }
            }

            //Only check if loaded when resume depth is 1. It is likely that
            //it is only greater than 1 in sync environments where a factory
            //function also then calls the callback-style require. In those
            //cases, the checkLoaded should not occur until the resume
            //depth is back at the top level.
            if (resumeDepth === 1) {
                checkLoaded();
            }

            resumeDepth -= 1;

            return undefined;
        };

        //Define the context object. Many of these fields are on here
        //just to make debugging easier.
        context = {
            contextName: contextName,
            config: config,
            defQueue: defQueue,
            waiting: waiting,
            waitCount: 0,
            specified: specified,
            loaded: loaded,
            urlMap: urlMap,
            urlFetched: urlFetched,
            scriptCount: 0,
            defined: defined,
            paused: [],
            pausedCount: 0,
            plugins: plugins,
            needFullExec: needFullExec,
            fake: {},
            fullExec: fullExec,
            managerCallbacks: managerCallbacks,
            makeModuleMap: makeModuleMap,
            normalize: normalize,
            /**
             * Set a configuration for the context.
             * @param {Object} cfg config object to integrate.
             */
            configure: function (cfg) {
                var paths, prop, packages, pkgs, packagePaths, requireWait;

                //Make sure the baseUrl ends in a slash.
                if (cfg.baseUrl) {
                    if (cfg.baseUrl.charAt(cfg.baseUrl.length - 1) !== "/") {
                        cfg.baseUrl += "/";
                    }
                }

                //Save off the paths and packages since they require special processing,
                //they are additive.
                paths = config.paths;
                packages = config.packages;
                pkgs = config.pkgs;

                //Mix in the config values, favoring the new values over
                //existing ones in context.config.
                mixin(config, cfg, true);

                //Adjust paths if necessary.
                if (cfg.paths) {
                    for (prop in cfg.paths) {
                        if (!(prop in empty)) {
                            paths[prop] = cfg.paths[prop];
                        }
                    }
                    config.paths = paths;
                }

                packagePaths = cfg.packagePaths;
                if (packagePaths || cfg.packages) {
                    //Convert packagePaths into a packages config.
                    if (packagePaths) {
                        for (prop in packagePaths) {
                            if (!(prop in empty)) {
                                configurePackageDir(pkgs, packagePaths[prop], prop);
                            }
                        }
                    }

                    //Adjust packages if necessary.
                    if (cfg.packages) {
                        configurePackageDir(pkgs, cfg.packages);
                    }

                    //Done with modifications, assing packages back to context config
                    config.pkgs = pkgs;
                }

                //If priority loading is in effect, trigger the loads now
                if (cfg.priority) {
                    //Hold on to requireWait value, and reset it after done
                    requireWait = context.requireWait;

                    //Allow tracing some require calls to allow the fetching
                    //of the priority config.
                    context.requireWait = false;
                    //But first, call resume to register any defined modules that may
                    //be in a data-main built file before the priority config
                    //call.
                    resume();

                    context.require(cfg.priority);

                    //Trigger a resume right away, for the case when
                    //the script with the priority load is done as part
                    //of a data-main call. In that case the normal resume
                    //call will not happen because the scriptCount will be
                    //at 1, since the script for data-main is being processed.
                    resume();

                    //Restore previous state.
                    context.requireWait = requireWait;
                    config.priorityWait = cfg.priority;
                }

                //If a deps array or a config callback is specified, then call
                //require with those args. This is useful when require is defined as a
                //config object before require.js is loaded.
                if (cfg.deps || cfg.callback) {
                    context.require(cfg.deps || [], cfg.callback);
                }
            },

            requireDefined: function (moduleName, relModuleMap) {
                return makeModuleMap(moduleName, relModuleMap).fullName in defined;
            },

            requireSpecified: function (moduleName, relModuleMap) {
                return makeModuleMap(moduleName, relModuleMap).fullName in specified;
            },

            require: function (deps, callback, relModuleMap) {
                var moduleName, fullName, moduleMap;
                if (typeof deps === "string") {
                    if (isFunction(callback)) {
                        //Invalid call
                        return req.onError(makeError("requireargs", "Invalid require call"));
                    }

                    //Synchronous access to one module. If require.get is
                    //available (as in the Node adapter), prefer that.
                    //In this case deps is the moduleName and callback is
                    //the relModuleMap
                    if (req.get) {
                        return req.get(context, deps, callback);
                    }

                    //Just return the module wanted. In this scenario, the
                    //second arg (if passed) is just the relModuleMap.
                    moduleName = deps;
                    relModuleMap = callback;

                    //Normalize module name, if it contains . or ..
                    moduleMap = makeModuleMap(moduleName, relModuleMap);
                    fullName = moduleMap.fullName;

                    if (!(fullName in defined)) {
                        return req.onError(makeError("notloaded", "Module name '" +
                                    moduleMap.fullName +
                                    "' has not been loaded yet for context: " +
                                    contextName));
                    }
                    return defined[fullName];
                }

                //Call main but only if there are dependencies or
                //a callback to call.
                if (deps && deps.length || callback) {
                    main(null, deps, callback, relModuleMap);
                }

                //If the require call does not trigger anything new to load,
                //then resume the dependency processing.
                if (!context.requireWait) {
                    while (!context.scriptCount && context.paused.length) {
                        resume();
                    }
                }
                return context.require;
            },

            /**
             * Internal method to transfer globalQueue items to this context's
             * defQueue.
             */
            takeGlobalQueue: function () {
                //Push all the globalDefQueue items into the context's defQueue
                if (globalDefQueue.length) {
                    //Array splice in the values since the context code has a
                    //local var ref to defQueue, so cannot just reassign the one
                    //on context.
                    apsp.apply(context.defQueue,
                               [context.defQueue.length - 1, 0].concat(globalDefQueue));
                    globalDefQueue = [];
                }
            },

            /**
             * Internal method used by environment adapters to complete a load event.
             * A load event could be a script load or just a load pass from a synchronous
             * load call.
             * @param {String} moduleName the name of the module to potentially complete.
             */
            completeLoad: function (moduleName) {
                var args;

                context.takeGlobalQueue();

                while (defQueue.length) {
                    args = defQueue.shift();

                    if (args[0] === null) {
                        args[0] = moduleName;
                        break;
                    } else if (args[0] === moduleName) {
                        //Found matching define call for this script!
                        break;
                    } else {
                        //Some other named define call, most likely the result
                        //of a build layer that included many define calls.
                        callDefMain(args);
                        args = null;
                    }
                }
                if (args) {
                    callDefMain(args);
                } else {
                    //A script that does not call define(), so just simulate
                    //the call for it. Special exception for jQuery dynamic load.
                    callDefMain([moduleName, [],
                                moduleName === "jquery" && typeof jQuery !== "undefined" ?
                                function () {
                                    return jQuery;
                                } : null]);
                }

                //Doing this scriptCount decrement branching because sync envs
                //need to decrement after resume, otherwise it looks like
                //loading is complete after the first dependency is fetched.
                //For browsers, it works fine to decrement after, but it means
                //the checkLoaded setTimeout 50 ms cost is taken. To avoid
                //that cost, decrement beforehand.
                if (req.isAsync) {
                    context.scriptCount -= 1;
                }
                resume();
                if (!req.isAsync) {
                    context.scriptCount -= 1;
                }
            },

            /**
             * Converts a module name + .extension into an URL path.
             * *Requires* the use of a module name. It does not support using
             * plain URLs like nameToUrl.
             */
            toUrl: function (moduleNamePlusExt, relModuleMap) {
                var index = moduleNamePlusExt.lastIndexOf("."),
                    ext = null;

                if (index !== -1) {
                    ext = moduleNamePlusExt.substring(index, moduleNamePlusExt.length);
                    moduleNamePlusExt = moduleNamePlusExt.substring(0, index);
                }

                return context.nameToUrl(moduleNamePlusExt, ext, relModuleMap);
            },

            /**
             * Converts a module name to a file path. Supports cases where
             * moduleName may actually be just an URL.
             */
            nameToUrl: function (moduleName, ext, relModuleMap) {
                var paths, pkgs, pkg, pkgPath, syms, i, parentModule, url,
                    config = context.config;

                //Normalize module name if have a base relative module name to work from.
                moduleName = normalize(moduleName, relModuleMap && relModuleMap.fullName);

                //If a colon is in the URL, it indicates a protocol is used and it is just
                //an URL to a file, or if it starts with a slash or ends with .js, it is just a plain file.
                //The slash is important for protocol-less URLs as well as full paths.
                if (req.jsExtRegExp.test(moduleName)) {
                    //Just a plain path, not module name lookup, so just return it.
                    //Add extension if it is included. This is a bit wonky, only non-.js things pass
                    //an extension, this method probably needs to be reworked.
                    url = moduleName + (ext ? ext : "");
                } else {
                    //A module that needs to be converted to a path.
                    paths = config.paths;
                    pkgs = config.pkgs;

                    syms = moduleName.split("/");
                    //For each module name segment, see if there is a path
                    //registered for it. Start with most specific name
                    //and work up from it.
                    for (i = syms.length; i > 0; i--) {
                        parentModule = syms.slice(0, i).join("/");
                        if (paths[parentModule]) {
                            syms.splice(0, i, paths[parentModule]);
                            break;
                        } else if ((pkg = pkgs[parentModule])) {
                            //If module name is just the package name, then looking
                            //for the main module.
                            if (moduleName === pkg.name) {
                                pkgPath = pkg.location + '/' + pkg.main;
                            } else {
                                pkgPath = pkg.location;
                            }
                            syms.splice(0, i, pkgPath);
                            break;
                        }
                    }

                    //Join the path parts together, then figure out if baseUrl is needed.
                    url = syms.join("/") + (ext || ".js");
                    url = (url.charAt(0) === '/' || url.match(/^\w+:/) ? "" : config.baseUrl) + url;
                }

                return config.urlArgs ? url +
                                        ((url.indexOf('?') === -1 ? '?' : '&') +
                                         config.urlArgs) : url;
            }
        };

        //Make these visible on the context so can be called at the very
        //end of the file to bootstrap
        context.jQueryCheck = jQueryCheck;
        context.resume = resume;

        return context;
    }

    /**
     * Main entry point.
     *
     * If the only argument to require is a string, then the module that
     * is represented by that string is fetched for the appropriate context.
     *
     * If the first argument is an array, then it will be treated as an array
     * of dependency string names to fetch. An optional function callback can
     * be specified to execute when all of those dependencies are available.
     *
     * Make a local req variable to help Caja compliance (it assumes things
     * on a require that are not standardized), and to give a short
     * name for minification/local scope use.
     */
    req = requirejs = function (deps, callback) {

        //Find the right context, use default
        var contextName = defContextName,
            context, config;

        // Determine if have config object in the call.
        if (!isArray(deps) && typeof deps !== "string") {
            // deps is a config object
            config = deps;
            if (isArray(callback)) {
                // Adjust args if there are dependencies
                deps = callback;
                callback = arguments[2];
            } else {
                deps = [];
            }
        }

        if (config && config.context) {
            contextName = config.context;
        }

        context = contexts[contextName] ||
                  (contexts[contextName] = newContext(contextName));

        if (config) {
            context.configure(config);
        }

        return context.require(deps, callback);
    };

    /**
     * Support require.config() to make it easier to cooperate with other
     * AMD loaders on globally agreed names.
     */
    req.config = function (config) {
        return req(config);
    };

    /**
     * Export require as a global, but only if it does not already exist.
     */
    if (!require) {
        require = req;
    }

    /**
     * Global require.toUrl(), to match global require, mostly useful
     * for debugging/work in the global space.
     */
    req.toUrl = function (moduleNamePlusExt) {
        return contexts[defContextName].toUrl(moduleNamePlusExt);
    };

    req.version = version;

    //Used to filter out dependencies that are already paths.
    req.jsExtRegExp = /^\/|:|\?|\.js$/;
    s = req.s = {
        contexts: contexts,
        //Stores a list of URLs that should not get async script tag treatment.
        skipAsync: {}
    };

    req.isAsync = req.isBrowser = isBrowser;
    if (isBrowser) {
        head = s.head = document.getElementsByTagName("head")[0];
        //If BASE tag is in play, using appendChild is a problem for IE6.
        //When that browser dies, this can be removed. Details in this jQuery bug:
        //http://dev.jquery.com/ticket/2709
        baseElement = document.getElementsByTagName("base")[0];
        if (baseElement) {
            head = s.head = baseElement.parentNode;
        }
    }

    /**
     * Any errors that require explicitly generates will be passed to this
     * function. Intercept/override it if you want custom error handling.
     * @param {Error} err the error object.
     */
    req.onError = function (err) {
        throw err;
    };

    /**
     * Does the request to load a module for the browser case.
     * Make this a separate function to allow other environments
     * to override it.
     *
     * @param {Object} context the require context to find state.
     * @param {String} moduleName the name of the module.
     * @param {Object} url the URL to the module.
     */
    req.load = function (context, moduleName, url) {
        req.resourcesReady(false);

        context.scriptCount += 1;
        req.attach(url, context, moduleName);

        //If tracking a jQuery, then make sure its ready callbacks
        //are put on hold to prevent its ready callbacks from
        //triggering too soon.
        if (context.jQuery && !context.jQueryIncremented) {
            jQueryHoldReady(context.jQuery, true);
            context.jQueryIncremented = true;
        }
    };

    function getInteractiveScript() {
        var scripts, i, script;
        if (interactiveScript && interactiveScript.readyState === 'interactive') {
            return interactiveScript;
        }

        scripts = document.getElementsByTagName('script');
        for (i = scripts.length - 1; i > -1 && (script = scripts[i]); i--) {
            if (script.readyState === 'interactive') {
                return (interactiveScript = script);
            }
        }

        return null;
    }

    /**
     * The function that handles definitions of modules. Differs from
     * require() in that a string for the module should be the first argument,
     * and the function to execute after dependencies are loaded should
     * return a value to define the module corresponding to the first argument's
     * name.
     */
    define = function (name, deps, callback) {
        var node, context;

        //Allow for anonymous functions
        if (typeof name !== 'string') {
            //Adjust args appropriately
            callback = deps;
            deps = name;
            name = null;
        }

        //This module may not have dependencies
        if (!isArray(deps)) {
            callback = deps;
            deps = [];
        }

        //If no name, and callback is a function, then figure out if it a
        //CommonJS thing with dependencies.
        if (!deps.length && isFunction(callback)) {
            //Remove comments from the callback string,
            //look for require calls, and pull them into the dependencies,
            //but only if there are function args.
            if (callback.length) {
                callback
                    .toString()
                    .replace(commentRegExp, "")
                    .replace(cjsRequireRegExp, function (match, dep) {
                        deps.push(dep);
                    });

                //May be a CommonJS thing even without require calls, but still
                //could use exports, and module. Avoid doing exports and module
                //work though if it just needs require.
                //REQUIRES the function to expect the CommonJS variables in the
                //order listed below.
                deps = (callback.length === 1 ? ["require"] : ["require", "exports", "module"]).concat(deps);
            }
        }

        //If in IE 6-8 and hit an anonymous define() call, do the interactive
        //work.
        if (useInteractive) {
            node = currentlyAddingScript || getInteractiveScript();
            if (node) {
                if (!name) {
                    name = node.getAttribute("data-requiremodule");
                }
                context = contexts[node.getAttribute("data-requirecontext")];
            }
        }

        //Always save off evaluating the def call until the script onload handler.
        //This allows multiple modules to be in a file without prematurely
        //tracing dependencies, and allows for anonymous module support,
        //where the module name is not known until the script onload event
        //occurs. If no context, use the global queue, and get it processed
        //in the onscript load callback.
        (context ? context.defQueue : globalDefQueue).push([name, deps, callback]);

        return undefined;
    };

    define.amd = {
        multiversion: true,
        plugins: true,
        jQuery: true
    };

    /**
     * Executes the text. Normally just uses eval, but can be modified
     * to use a more environment specific call.
     * @param {String} text the text to execute/evaluate.
     */
    req.exec = function (text) {
        return eval(text);
    };

    /**
     * Executes a module callack function. Broken out as a separate function
     * solely to allow the build system to sequence the files in the built
     * layer in the right sequence.
     *
     * @private
     */
    req.execCb = function (name, callback, args, exports) {
        return callback.apply(exports, args);
    };


    /**
     * Adds a node to the DOM. Public function since used by the order plugin.
     * This method should not normally be called by outside code.
     */
    req.addScriptToDom = function (node) {
        //For some cache cases in IE 6-8, the script executes before the end
        //of the appendChild execution, so to tie an anonymous define
        //call to the module name (which is stored on the node), hold on
        //to a reference to this node, but clear after the DOM insertion.
        currentlyAddingScript = node;
        if (baseElement) {
            head.insertBefore(node, baseElement);
        } else {
            head.appendChild(node);
        }
        currentlyAddingScript = null;
    };

    /**
     * callback for script loads, used to check status of loading.
     *
     * @param {Event} evt the event from the browser for the script
     * that was loaded.
     *
     * @private
     */
    req.onScriptLoad = function (evt) {
        //Using currentTarget instead of target for Firefox 2.0's sake. Not
        //all old browsers will be supported, but this one was easy enough
        //to support and still makes sense.
        var node = evt.currentTarget || evt.srcElement, contextName, moduleName,
            context;

        if (evt.type === "load" || (node && readyRegExp.test(node.readyState))) {
            //Reset interactive script so a script node is not held onto for
            //to long.
            interactiveScript = null;

            //Pull out the name of the module and the context.
            contextName = node.getAttribute("data-requirecontext");
            moduleName = node.getAttribute("data-requiremodule");
            context = contexts[contextName];

            contexts[contextName].completeLoad(moduleName);

            //Clean up script binding. Favor detachEvent because of IE9
            //issue, see attachEvent/addEventListener comment elsewhere
            //in this file.
            if (node.detachEvent && !isOpera) {
                //Probably IE. If not it will throw an error, which will be
                //useful to know.
                node.detachEvent("onreadystatechange", req.onScriptLoad);
            } else {
                node.removeEventListener("load", req.onScriptLoad, false);
            }
        }
    };

    /**
     * Attaches the script represented by the URL to the current
     * environment. Right now only supports browser loading,
     * but can be redefined in other environments to do the right thing.
     * @param {String} url the url of the script to attach.
     * @param {Object} context the context that wants the script.
     * @param {moduleName} the name of the module that is associated with the script.
     * @param {Function} [callback] optional callback, defaults to require.onScriptLoad
     * @param {String} [type] optional type, defaults to text/javascript
     * @param {Function} [fetchOnlyFunction] optional function to indicate the script node
     * should be set up to fetch the script but do not attach it to the DOM
     * so that it can later be attached to execute it. This is a way for the
     * order plugin to support ordered loading in IE. Once the script is fetched,
     * but not executed, the fetchOnlyFunction will be called.
     */
    req.attach = function (url, context, moduleName, callback, type, fetchOnlyFunction) {
        var node;
        if (isBrowser) {
            //In the browser so use a script tag
            callback = callback || req.onScriptLoad;
            node = context && context.config && context.config.xhtml ?
                    document.createElementNS("http://www.w3.org/1999/xhtml", "html:script") :
                    document.createElement("script");
            node.type = type || (context && context.config.scriptType) ||
                        "text/javascript";
            node.charset = "utf-8";
            //Use async so Gecko does not block on executing the script if something
            //like a long-polling comet tag is being run first. Gecko likes
            //to evaluate scripts in DOM order, even for dynamic scripts.
            //It will fetch them async, but only evaluate the contents in DOM
            //order, so a long-polling script tag can delay execution of scripts
            //after it. But telling Gecko we expect async gets us the behavior
            //we want -- execute it whenever it is finished downloading. Only
            //Helps Firefox 3.6+
            //Allow some URLs to not be fetched async. Mostly helps the order!
            //plugin
            node.async = !s.skipAsync[url];

            if (context) {
                node.setAttribute("data-requirecontext", context.contextName);
            }
            node.setAttribute("data-requiremodule", moduleName);

            //Set up load listener. Test attachEvent first because IE9 has
            //a subtle issue in its addEventListener and script onload firings
            //that do not match the behavior of all other browsers with
            //addEventListener support, which fire the onload event for a
            //script right after the script execution. See:
            //https://connect.microsoft.com/IE/feedback/details/648057/script-onload-event-is-not-fired-immediately-after-script-execution
            //UNFORTUNATELY Opera implements attachEvent but does not follow the script
            //script execution mode.
            if (node.attachEvent && !isOpera) {
                //Probably IE. IE (at least 6-8) do not fire
                //script onload right after executing the script, so
                //we cannot tie the anonymous define call to a name.
                //However, IE reports the script as being in "interactive"
                //readyState at the time of the define call.
                useInteractive = true;


                if (fetchOnlyFunction) {
                    //Need to use old school onreadystate here since
                    //when the event fires and the node is not attached
                    //to the DOM, the evt.srcElement is null, so use
                    //a closure to remember the node.
                    node.onreadystatechange = function (evt) {
                        //Script loaded but not executed.
                        //Clear loaded handler, set the real one that
                        //waits for script execution.
                        if (node.readyState === 'loaded') {
                            node.onreadystatechange = null;
                            node.attachEvent("onreadystatechange", callback);
                            fetchOnlyFunction(node);
                        }
                    };
                } else {
                    node.attachEvent("onreadystatechange", callback);
                }
            } else {
                node.addEventListener("load", callback, false);
            }
            node.src = url;

            //Fetch only means waiting to attach to DOM after loaded.
            if (!fetchOnlyFunction) {
                req.addScriptToDom(node);
            }

            return node;
        } else if (isWebWorker) {
            //In a web worker, use importScripts. This is not a very
            //efficient use of importScripts, importScripts will block until
            //its script is downloaded and evaluated. However, if web workers
            //are in play, the expectation that a build has been done so that
            //only one script needs to be loaded anyway. This may need to be
            //reevaluated if other use cases become common.
            importScripts(url);

            //Account for anonymous modules
            context.completeLoad(moduleName);
        }
        return null;
    };

    //Look for a data-main script attribute, which could also adjust the baseUrl.
    if (isBrowser) {
        //Figure out baseUrl. Get it from the script tag with require.js in it.
        scripts = document.getElementsByTagName("script");

        for (globalI = scripts.length - 1; globalI > -1 && (script = scripts[globalI]); globalI--) {
            //Set the "head" where we can append children by
            //using the script's parent.
            if (!head) {
                head = script.parentNode;
            }

            //Look for a data-main attribute to set main script for the page
            //to load. If it is there, the path to data main becomes the
            //baseUrl, if it is not already set.
            if ((dataMain = script.getAttribute('data-main'))) {
                if (!cfg.baseUrl) {
                    //Pull off the directory of data-main for use as the
                    //baseUrl.
                    src = dataMain.split('/');
                    mainScript = src.pop();
                    subPath = src.length ? src.join('/')  + '/' : './';

                    //Set final config.
                    cfg.baseUrl = subPath;
                    //Strip off any trailing .js since dataMain is now
                    //like a module name.
                    dataMain = mainScript.replace(jsSuffixRegExp, '');
                }

                //Put the data-main script in the files to load.
                cfg.deps = cfg.deps ? cfg.deps.concat(dataMain) : [dataMain];

                break;
            }
        }
    }

    //See if there is nothing waiting across contexts, and if not, trigger
    //resourcesReady.
    req.checkReadyState = function () {
        var contexts = s.contexts, prop;
        for (prop in contexts) {
            if (!(prop in empty)) {
                if (contexts[prop].waitCount) {
                    return;
                }
            }
        }
        req.resourcesReady(true);
    };

    /**
     * Internal function that is triggered whenever all scripts/resources
     * have been loaded by the loader. Can be overridden by other, for
     * instance the domReady plugin, which wants to know when all resources
     * are loaded.
     */
    req.resourcesReady = function (isReady) {
        var contexts, context, prop;

        //First, set the public variable indicating that resources are loading.
        req.resourcesDone = isReady;

        if (req.resourcesDone) {
            //If jQuery with DOM ready delayed, release it now.
            contexts = s.contexts;
            for (prop in contexts) {
                if (!(prop in empty)) {
                    context = contexts[prop];
                    if (context.jQueryIncremented) {
                        jQueryHoldReady(context.jQuery, false);
                        context.jQueryIncremented = false;
                    }
                }
            }
        }
    };

    //FF < 3.6 readyState fix. Needed so that domReady plugin
    //works well in that environment, since require.js is normally
    //loaded via an HTML script tag so it will be there before window load,
    //where the domReady plugin is more likely to be loaded after window load.
    req.pageLoaded = function () {
        if (document.readyState !== "complete") {
            document.readyState = "complete";
        }
    };
    if (isBrowser) {
        if (document.addEventListener) {
            if (!document.readyState) {
                document.readyState = "loading";
                window.addEventListener("load", req.pageLoaded, false);
            }
        }
    }

    //Set up default context. If require was a configuration object, use that as base config.
    req(cfg);

    //If modules are built into require.js, then need to make sure dependencies are
    //traced. Use a setTimeout in the browser world, to allow all the modules to register
    //themselves. In a non-browser env, assume that modules are not built into require.js,
    //which seems odd to do on the server.
    if (req.isAsync && typeof setTimeout !== "undefined") {
        ctx = s.contexts[(cfg.context || defContextName)];
        //Indicate that the script that includes require() is still loading,
        //so that require()'d dependencies are not traced until the end of the
        //file is parsed (approximated via the setTimeout call).
        ctx.requireWait = true;
        setTimeout(function () {
            ctx.requireWait = false;

            if (!ctx.scriptCount) {
                ctx.resume();
            }
            req.checkReadyState();
        }, 0);
    }
}());
;this['JST'] = this['JST'] || {};

this['JST']['app/templates/about.html'] = function(obj){
var __p='';var print=function(){__p+=Array.prototype.join.call(arguments, '')};
with(obj||{}){
__p+='\n<h1>About this demo</h1>\n\n<p>\n  This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. \n</p>\n\n<p>\n  This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. \n\n<p>\n  This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. This is the about page. This is a test. \n</p>\n';
}
return __p;
};

this['JST']['app/templates/contact.html'] = function(obj){
var __p='';var print=function(){__p+=Array.prototype.join.call(arguments, '')};
with(obj||{}){
__p+='\n<h1>Contact</h1>\n\n';
}
return __p;
};

this['JST']['app/templates/detail.html'] = function(obj){
var __p='';var print=function(){__p+=Array.prototype.join.call(arguments, '')};
with(obj||{}){
__p+='<div class="background modal"></div>\n\n<div class="detailmodel modal">\n\n  <table align="center" cellspacing="5" cellpadding="10" width="100%">\n    <tr>\n      <td width="25%" align="right"><b>Song Name :</b></td>\n      <td>'+
(name)+
'</td>\n    </tr>\n    <tr>\n      <td align="right"><b>Year :</b></td>\n      <td>'+
(year)+
'</td>\n    </tr>\n    <tr>\n      <td align="right"><b>Album :</b></td>\n      <td>'+
(album)+
'</td>\n    </tr>\n    <tr>\n      <td align="right"><b>Quote :</b></td>\n      <td>'+
(quote)+
'</td>\n    </tr>\n    <tr>\n      <td>&nbsp;</td>\n    </tr>\n    <tr>\n      <td align="center" style="color: gray; border-top: 1px solid gray" colspan="2">\n      <i style="font-size: 8">Click anywhere to close this song detail.</i>\n      </td>\n    </tr>\n  </table>\n\n</div>\n\n';
}
return __p;
};

this['JST']['app/templates/table.html'] = function(obj){
var __p='';var print=function(){__p+=Array.prototype.join.call(arguments, '')};
with(obj||{}){
__p+='\n\n<h1>Backbone.js - Cloudspokes Beasty Boys Tribute</h1>\n  \n<p>This is a short code challenge offered by Cloudspokes.com in May of 2012.</p>\n\n<p>This is an example backbone.js application, built for the Cloudspokes.com \n   code challenge in 2012. This example use Require.js, MockJax, Backbone.js\n   and jQuery. The base boilerplate is a backbone.js example provides by Thomas\n   Davis. Moving from a basic backbone.js to a production ready code base requires\n   some planning and code structure. The require.js project helps with this \n   coding pattern.\n</p>\n\n<div class="span10" style="color: gray; margin-bottom: 10px;font-size: 12px;">\n  <i>Double Click on Any Item to see details.\n</div>\n\n<div id="tablegrid" >\n   ';
 _.each(songs, function(i) { 
;__p+=' \n   <div class="gridrow" id="'+
( i.id )+
'" >\n     <div class="col name" id="'+
( i.id )+
'" >Song:<br><a class="detail" id="'+
( i.id )+
'" href="#">'+
( i.name )+
'</a></div>\n     <div class="col year" id="'+
( i.id )+
'" >year:<br>'+
( i.year )+
'&nbsp;</div>\n     <div class="col album" id="'+
( i.id )+
'" >Album:<br>'+
( i.album )+
'&nbsp;</div>\n     <div class="col length" id="'+
( i.id )+
'" >Length:<br>'+
( i.length )+
'&nbsp;</div>\n     <div class="col desc" id="'+
( i.id )+
'" >Quote:<br>'+
( i.quote )+
'&nbsp;</div>\n     <br style="clear: both">\n   </div>\n   ';
 }); 
;__p+='\n</div>\n\n<div class="span10" style="color: gray; margin-bottom: 10px;font-size: 12px;">\n  <i>Double Click on Any Item to see details.\n</div>\n';
}
return __p;
};;/*!
 * jQuery JavaScript Library v1.7.1
 * http://jquery.com/
 *
 * Copyright 2011, John Resig
 * Dual licensed under the MIT or GPL Version 2 licenses.
 * http://jquery.org/license
 *
 * Includes Sizzle.js
 * http://sizzlejs.com/
 * Copyright 2011, The Dojo Foundation
 * Released under the MIT, BSD, and GPL Licenses.
 *
 * Date: Mon Nov 21 21:11:03 2011 -0500
 */

/*!
 * Sizzle CSS Selector Engine
 *  Copyright 2011, The Dojo Foundation
 *  Released under the MIT, BSD, and GPL Licenses.
 *  More information: http://sizzlejs.com/
 */

/* RequireJS Use Plugin v0.1.0
 * Copyright 2012, Tim Branyen (@tbranyen)
 * use.js may be freely distributed under the MIT license.
 */

//     Underscore.js 1.3.1
//     (c) 2009-2012 Jeremy Ashkenas, DocumentCloud Inc.
//     Underscore is freely distributable under the MIT license.
//     Portions of Underscore are inspired or borrowed from Prototype,
//     Oliver Steele's Functional, and John Resig's Micro-Templating.
//     For all details and documentation:
//     http://documentcloud.github.com/underscore

//     (c) 2010-2012 Jeremy Ashkenas, DocumentCloud Inc.
//     Backbone may be freely distributed under the MIT license.
//     For all details and documentation:
//     http://backbonejs.org

/*! jQuery UI - v1.8.19 - 2012-04-16
* https://github.com/jquery/jquery-ui
* Includes: jquery.ui.core.js, jquery.ui.widget.js, jquery.ui.mouse.js, jquery.ui.draggable.js, jquery.ui.droppable.js, jquery.ui.resizable.js, jquery.ui.selectable.js, jquery.ui.sortable.js, jquery.effects.core.js, jquery.effects.blind.js, jquery.effects.bounce.js, jquery.effects.clip.js, jquery.effects.drop.js, jquery.effects.explode.js, jquery.effects.fade.js, jquery.effects.fold.js, jquery.effects.highlight.js, jquery.effects.pulsate.js, jquery.effects.scale.js, jquery.effects.shake.js, jquery.effects.slide.js, jquery.effects.transfer.js, jquery.ui.accordion.js, jquery.ui.autocomplete.js, jquery.ui.button.js, jquery.ui.datepicker.js, jquery.ui.dialog.js, jquery.ui.position.js, jquery.ui.progressbar.js, jquery.ui.slider.js, jquery.ui.tabs.js
* Copyright (c) 2012 AUTHORS.txt; Licensed MIT, GPL */

/*
 * jQuery Easing v1.3 - http://gsgd.co.uk/sandbox/jquery/easing/
 *
 * Uses the built in easing capabilities added In jQuery 1.1
 * to offer multiple easing options
 *
 * TERMS OF USE - jQuery Easing
 *
 * Open source under the BSD License.
 *
 * Copyright 2008 George McGinley Smith
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 * Redistributions of source code must retain the above copyright notice, this list of
 * conditions and the following disclaimer.
 * Redistributions in binary form must reproduce the above copyright notice, this list
 * of conditions and the following disclaimer in the documentation and/or other materials
 * provided with the distribution.
 *
 * Neither the name of the author nor the names of contributors may be used to endorse
 * or promote products derived from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
 * COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE
 * GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED
 * AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 * NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED
 * OF THE POSSIBILITY OF SUCH DAMAGE.
 *
*/

/*
 *
 * TERMS OF USE - EASING EQUATIONS
 *
 * Open source under the BSD License.
 *
 * Copyright 2001 Robert Penner
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 * Redistributions of source code must retain the above copyright notice, this list of
 * conditions and the following disclaimer.
 * Redistributions in binary form must reproduce the above copyright notice, this list
 * of conditions and the following disclaimer in the documentation and/or other materials
 * provided with the distribution.
 *
 * Neither the name of the author nor the names of contributors may be used to endorse
 * or promote products derived from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
 * COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE
 * GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED
 * AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 * NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED
 * OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 */

/*
 * jQuery UI Menu (not officially released)
 * 
 * This widget isn't yet finished and the API is subject to change. We plan to finish
 * it for the next release. You're welcome to give it a try anyway and give us feedback,
 * as long as you're okay with migrating your code later on. We can help with that, too.
 *
 * Copyright 2010, AUTHORS.txt (http://jqueryui.com/about)
 * Dual licensed under the MIT or GPL Version 2 licenses.
 * http://jquery.org/license
 *
 * http://docs.jquery.com/UI/Menu
 *
 * Depends:
 *	jquery.ui.core.js
 *  jquery.ui.widget.js
 */

/*!
 * MockJax - jQuery Plugin to Mock Ajax requests
 *
 * Version:  1.5.0pre
 * Released:
 * Home:   http://github.com/appendto/jquery-mockjax
 * Author:   Jonathan Sharp (http://jdsharp.com)
 * License:  MIT,GPL
 *
 * Copyright (c) 2011 appendTo LLC.
 * Dual licensed under the MIT or GPL licenses.
 * http://appendto.com/open-source-licenses
 */

(function(e,t){function u(e){var t=o[e]={},n,r;e=e.split(/\s+/);for(n=0,r=e.length;n<r;n++)t[e[n]]=!0;return t}function c(e,n,r){if(r===t&&e.nodeType===1){var i="data-"+n.replace(l,"-$1").toLowerCase();r=e.getAttribute(i);if(typeof r=="string"){try{r=r==="true"?!0:r==="false"?!1:r==="null"?null:s.isNumeric(r)?parseFloat(r):f.test(r)?s.parseJSON(r):r}catch(o){}s.data(e,n,r)}else r=t}return r}function h(e){for(var t in e){if(t==="data"&&s.isEmptyObject(e[t]))continue;if(t!=="toJSON")return!1}return!0}function p(e,t,n){var r=t+"defer",i=t+"queue",o=t+"mark",u=s._data(e,r);u&&(n==="queue"||!s._data(e,i))&&(n==="mark"||!s._data(e,o))&&setTimeout(function(){!s._data(e,i)&&!s._data(e,o)&&(s.removeData(e,r,!0),u.fire())},0)}function H(){return!1}function B(){return!0}function W(e){return!e||!e.parentNode||e.parentNode.nodeType===11}function X(e,t,n){t=t||0;if(s.isFunction(t))return s.grep(e,function(e,r){var i=!!t.call(e,r,e);return i===n});if(t.nodeType)return s.grep(e,function(e,r){return e===t===n});if(typeof t=="string"){var r=s.grep(e,function(e){return e.nodeType===1});if(q.test(t))return s.filter(t,r,!n);t=s.filter(t,r)}return s.grep(e,function(e,r){return s.inArray(e,t)>=0===n})}function V(e){var t=$.split("|"),n=e.createDocumentFragment();if(n.createElement)while(t.length)n.createElement(t.pop());return n}function at(e,t){return s.nodeName(e,"table")?e.getElementsByTagName("tbody")[0]||e.appendChild(e.ownerDocument.createElement("tbody")):e}function ft(e,t){if(t.nodeType!==1||!s.hasData(e))return;var n,r,i,o=s._data(e),u=s._data(t,o),a=o.events;if(a){delete u.handle,u.events={};for(n in a)for(r=0,i=a[n].length;r<i;r++)s.event.add(t,n+(a[n][r].namespace?".":"")+a[n][r].namespace,a[n][r],a[n][r].data)}u.data&&(u.data=s.extend({},u.data))}function lt(e,t){var n;if(t.nodeType!==1)return;t.clearAttributes&&t.clearAttributes(),t.mergeAttributes&&t.mergeAttributes(e),n=t.nodeName.toLowerCase();if(n==="object")t.outerHTML=e.outerHTML;else if(n!=="input"||e.type!=="checkbox"&&e.type!=="radio"){if(n==="option")t.selected=e.defaultSelected;else if(n==="input"||n==="textarea")t.defaultValue=e.defaultValue}else e.checked&&(t.defaultChecked=t.checked=e.checked),t.value!==e.value&&(t.value=e.value);t.removeAttribute(s.expando)}function ct(e){return typeof e.getElementsByTagName!="undefined"?e.getElementsByTagName("*"):typeof e.querySelectorAll!="undefined"?e.querySelectorAll("*"):[]}function ht(e){if(e.type==="checkbox"||e.type==="radio")e.defaultChecked=e.checked}function pt(e){var t=(e.nodeName||"").toLowerCase();t==="input"?ht(e):t!=="script"&&typeof e.getElementsByTagName!="undefined"&&s.grep(e.getElementsByTagName("input"),ht)}function dt(e){var t=n.createElement("div");return ut.appendChild(t),t.innerHTML=e.outerHTML,t.firstChild}function vt(e,t){t.src?s.ajax({url:t.src,async:!1,dataType:"script"}):s.globalEval((t.text||t.textContent||t.innerHTML||"").replace(st,"/*$0*/")),t.parentNode&&t.parentNode.removeChild(t)}function Lt(e,t,n){var r=t==="width"?e.offsetWidth:e.offsetHeight,i=t==="width"?xt:Tt,o=0,u=i.length;if(r>0){if(n!=="border")for(;o<u;o++)n||(r-=parseFloat(s.css(e,"padding"+i[o]))||0),n==="margin"?r+=parseFloat(s.css(e,n+i[o]))||0:r-=parseFloat(s.css(e,"border"+i[o]+"Width"))||0;return r+"px"}r=Nt(e,t,t);if(r<0||r==null)r=e.style[t]||0;r=parseFloat(r)||0;if(n)for(;o<u;o++)r+=parseFloat(s.css(e,"padding"+i[o]))||0,n!=="padding"&&(r+=parseFloat(s.css(e,"border"+i[o]+"Width"))||0),n==="margin"&&(r+=parseFloat(s.css(e,n+i[o]))||0);return r+"px"}function Gt(e){return function(t,n){typeof t!="string"&&(n=t,t="*");if(s.isFunction(n)){var r=t.toLowerCase().split(Rt),i=0,o=r.length,u,a,f;for(;i<o;i++)u=r[i],f=/^\+/.test(u),f&&(u=u.substr(1)||"*"),a=e[u]=e[u]||[],a[f?"unshift":"push"](n)}}}function Yt(e,n,r,i,s,o){s=s||n.dataTypes[0],o=o||{},o[s]=!0;var u=e[s],a=0,f=u?u.length:0,l=e===Xt,c;for(;a<f&&(l||!c);a++)c=u[a](n,r,i),typeof c=="string"&&(!l||o[c]?c=t:(n.dataTypes.unshift(c),c=Yt(e,n,r,i,c,o)));return(l||!c)&&!o["*"]&&(c=Yt(e,n,r,i,"*",o)),c}function Zt(e,n){var r,i,o=s.ajaxSettings.flatOptions||{};for(r in n)n[r]!==t&&((o[r]?e:i||(i={}))[r]=n[r]);i&&s.extend(!0,e,i)}function en(e,t,n,r){if(s.isArray(t))s.each(t,function(t,i){n||Ot.test(e)?r(e,i):en(e+"["+(typeof i=="object"||s.isArray(i)?t:"")+"]",i,n,r)});else if(!n&&t!=null&&typeof t=="object")for(var i in t)en(e+"["+i+"]",t[i],n,r);else r(e,t)}function tn(e,n,r){var i=e.contents,s=e.dataTypes,o=e.responseFields,u,a,f,l;for(a in o)a in r&&(n[o[a]]=r[a]);while(s[0]==="*")s.shift(),u===t&&(u=e.mimeType||n.getResponseHeader("content-type"));if(u)for(a in i)if(i[a]&&i[a].test(u)){s.unshift(a);break}if(s[0]in r)f=s[0];else{for(a in r){if(!s[0]||e.converters[a+" "+s[0]]){f=a;break}l||(l=a)}f=f||l}if(f)return f!==s[0]&&s.unshift(f),r[f]}function nn(e,n){e.dataFilter&&(n=e.dataFilter(n,e.dataType));var r=e.dataTypes,i={},o,u,a=r.length,f,l=r[0],c,h,p,d,v;for(o=1;o<a;o++){if(o===1)for(u in e.converters)typeof u=="string"&&(i[u.toLowerCase()]=e.converters[u]);c=l,l=r[o];if(l==="*")l=c;else if(c!=="*"&&c!==l){h=c+" "+l,p=i[h]||i["* "+l];if(!p){v=t;for(d in i){f=d.split(" ");if(f[0]===c||f[0]==="*"){v=i[f[1]+" "+l];if(v){d=i[d],d===!0?p=v:v===!0&&(p=d);break}}}}!p&&!v&&s.error("No conversion from "+h.replace(" "," to ")),p!==!0&&(n=p?p(n):v(d(n)))}}return n}function fn(){try{return new e.XMLHttpRequest}catch(t){}}function ln(){try{return new e.ActiveXObject("Microsoft.XMLHTTP")}catch(t){}}function bn(){return setTimeout(wn,0),yn=s.now()}function wn(){yn=t}function En(e,t){var n={};return s.each(gn.concat.apply([],gn.slice(0,t)),function(){n[this]=e}),n}function Sn(e){if(!cn[e]){var t=n.body,r=s("<"+e+">").appendTo(t),i=r.css("display");r.remove();if(i==="none"||i===""){hn||(hn=n.createElement("iframe"),hn.frameBorder=hn.width=hn.height=0),t.appendChild(hn);if(!pn||!hn.createElement)pn=(hn.contentWindow||hn.contentDocument).document,pn.write((n.compatMode==="CSS1Compat"?"<!doctype html>":"")+"<html><body>"),pn.close();r=pn.createElement(e),pn.body.appendChild(r),i=s.css(r,"display"),t.removeChild(hn)}cn[e]=i}return cn[e]}function Nn(e){return s.isWindow(e)?e:e.nodeType===9?e.defaultView||e.parentWindow:!1}var n=e.document,r=e.navigator,i=e.location,s=function(){function H(){if(i.isReady)return;try{n.documentElement.doScroll("left")}catch(e){setTimeout(H,1);return}i.ready()}var i=function(e,t){return new i.fn.init(e,t,u)},s=e.jQuery,o=e.$,u,a=/^(?:[^#<]*(<[\w\W]+>)[^>]*$|#([\w\-]*)$)/,f=/\S/,l=/^\s+/,c=/\s+$/,h=/^<(\w+)\s*\/?>(?:<\/\1>)?$/,p=/^[\],:{}\s]*$/,d=/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g,v=/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g,m=/(?:^|:|,)(?:\s*\[)+/g,g=/(webkit)[ \/]([\w.]+)/,y=/(opera)(?:.*version)?[ \/]([\w.]+)/,b=/(msie) ([\w.]+)/,w=/(mozilla)(?:.*? rv:([\w.]+))?/,E=/-([a-z]|[0-9])/ig,S=/^-ms-/,x=function(e,t){return(t+"").toUpperCase()},T=r.userAgent,N,C,k,L=Object.prototype.toString,A=Object.prototype.hasOwnProperty,O=Array.prototype.push,M=Array.prototype.slice,_=String.prototype.trim,D=Array.prototype.indexOf,P={};return i.fn=i.prototype={constructor:i,init:function(e,r,s){var o,u,f,l;if(!e)return this;if(e.nodeType)return this.context=this[0]=e,this.length=1,this;if(e==="body"&&!r&&n.body)return this.context=n,this[0]=n.body,this.selector=e,this.length=1,this;if(typeof e=="string"){e.charAt(0)==="<"&&e.charAt(e.length-1)===">"&&e.length>=3?o=[null,e,null]:o=a.exec(e);if(o&&(o[1]||!r)){if(o[1])return r=r instanceof i?r[0]:r,l=r?r.ownerDocument||r:n,f=h.exec(e),f?i.isPlainObject(r)?(e=[n.createElement(f[1])],i.fn.attr.call(e,r,!0)):e=[l.createElement(f[1])]:(f=i.buildFragment([o[1]],[l]),e=(f.cacheable?i.clone(f.fragment):f.fragment).childNodes),i.merge(this,e);u=n.getElementById(o[2]);if(u&&u.parentNode){if(u.id!==o[2])return s.find(e);this.length=1,this[0]=u}return this.context=n,this.selector=e,this}return!r||r.jquery?(r||s).find(e):this.constructor(r).find(e)}return i.isFunction(e)?s.ready(e):(e.selector!==t&&(this.selector=e.selector,this.context=e.context),i.makeArray(e,this))},selector:"",jquery:"1.7.1",length:0,size:function(){return this.length},toArray:function(){return M.call(this,0)},get:function(e){return e==null?this.toArray():e<0?this[this.length+e]:this[e]},pushStack:function(e,t,n){var r=this.constructor();return i.isArray(e)?O.apply(r,e):i.merge(r,e),r.prevObject=this,r.context=this.context,t==="find"?r.selector=this.selector+(this.selector?" ":"")+n:t&&(r.selector=this.selector+"."+t+"("+n+")"),r},each:function(e,t){return i.each(this,e,t)},ready:function(e){return i.bindReady(),C.add(e),this},eq:function(e){return e=+e,e===-1?this.slice(e):this.slice(e,e+1)},first:function(){return this.eq(0)},last:function(){return this.eq(-1)},slice:function(){return this.pushStack(M.apply(this,arguments),"slice",M.call(arguments).join(","))},map:function(e){return this.pushStack(i.map(this,function(t,n){return e.call(t,n,t)}))},end:function(){return this.prevObject||this.constructor(null)},push:O,sort:[].sort,splice:[].splice},i.fn.init.prototype=i.fn,i.extend=i.fn.extend=function(){var e,n,r,s,o,u,a=arguments[0]||{},f=1,l=arguments.length,c=!1;typeof a=="boolean"&&(c=a,a=arguments[1]||{},f=2),typeof a!="object"&&!i.isFunction(a)&&(a={}),l===f&&(a=this,--f);for(;f<l;f++)if((e=arguments[f])!=null)for(n in e){r=a[n],s=e[n];if(a===s)continue;c&&s&&(i.isPlainObject(s)||(o=i.isArray(s)))?(o?(o=!1,u=r&&i.isArray(r)?r:[]):u=r&&i.isPlainObject(r)?r:{},a[n]=i.extend(c,u,s)):s!==t&&(a[n]=s)}return a},i.extend({noConflict:function(t){return e.$===i&&(e.$=o),t&&e.jQuery===i&&(e.jQuery=s),i},isReady:!1,readyWait:1,holdReady:function(e){e?i.readyWait++:i.ready(!0)},ready:function(e){if(e===!0&&!--i.readyWait||e!==!0&&!i.isReady){if(!n.body)return setTimeout(i.ready,1);i.isReady=!0;if(e!==!0&&--i.readyWait>0)return;C.fireWith(n,[i]),i.fn.trigger&&i(n).trigger("ready").off("ready")}},bindReady:function(){if(C)return;C=i.Callbacks("once memory");if(n.readyState==="complete")return setTimeout(i.ready,1);if(n.addEventListener)n.addEventListener("DOMContentLoaded",k,!1),e.addEventListener("load",i.ready,!1);else if(n.attachEvent){n.attachEvent("onreadystatechange",k),e.attachEvent("onload",i.ready);var t=!1;try{t=e.frameElement==null}catch(r){}n.documentElement.doScroll&&t&&H()}},isFunction:function(e){return i.type(e)==="function"},isArray:Array.isArray||function(e){return i.type(e)==="array"},isWindow:function(e){return e&&typeof e=="object"&&"setInterval"in e},isNumeric:function(e){return!isNaN(parseFloat(e))&&isFinite(e)},type:function(e){return e==null?String(e):P[L.call(e)]||"object"},isPlainObject:function(e){if(!e||i.type(e)!=="object"||e.nodeType||i.isWindow(e))return!1;try{if(e.constructor&&!A.call(e,"constructor")&&!A.call(e.constructor.prototype,"isPrototypeOf"))return!1}catch(n){return!1}var r;for(r in e);return r===t||A.call(e,r)},isEmptyObject:function(e){for(var t in e)return!1;return!0},error:function(e){throw new Error(e)},parseJSON:function(t){if(typeof t!="string"||!t)return null;t=i.trim(t);if(e.JSON&&e.JSON.parse)return e.JSON.parse(t);if(p.test(t.replace(d,"@").replace(v,"]").replace(m,"")))return(new Function("return "+t))();i.error("Invalid JSON: "+t)},parseXML:function(n){var r,s;try{e.DOMParser?(s=new DOMParser,r=s.parseFromString(n,"text/xml")):(r=new ActiveXObject("Microsoft.XMLDOM"),r.async="false",r.loadXML(n))}catch(o){r=t}return(!r||!r.documentElement||r.getElementsByTagName("parsererror").length)&&i.error("Invalid XML: "+n),r},noop:function(){},globalEval:function(t){t&&f.test(t)&&(e.execScript||function(t){e.eval.call(e,t)})(t)},camelCase:function(e){return e.replace(S,"ms-").replace(E,x)},nodeName:function(e,t){return e.nodeName&&e.nodeName.toUpperCase()===t.toUpperCase()},each:function(e,n,r){var s,o=0,u=e.length,a=u===t||i.isFunction(e);if(r){if(a){for(s in e)if(n.apply(e[s],r)===!1)break}else for(;o<u;)if(n.apply(e[o++],r)===!1)break}else if(a){for(s in e)if(n.call(e[s],s,e[s])===!1)break}else for(;o<u;)if(n.call(e[o],o,e[o++])===!1)break;return e},trim:_?function(e){return e==null?"":_.call(e)}:function(e){return e==null?"":e.toString().replace(l,"").replace(c,"")},makeArray:function(e,t){var n=t||[];if(e!=null){var r=i.type(e);e.length==null||r==="string"||r==="function"||r==="regexp"||i.isWindow(e)?O.call(n,e):i.merge(n,e)}return n},inArray:function(e,t,n){var r;if(t){if(D)return D.call(t,e,n);r=t.length,n=n?n<0?Math.max(0,r+n):n:0;for(;n<r;n++)if(n in t&&t[n]===e)return n}return-1},merge:function(e,n){var r=e.length,i=0;if(typeof n.length=="number")for(var s=n.length;i<s;i++)e[r++]=n[i];else while(n[i]!==t)e[r++]=n[i++];return e.length=r,e},grep:function(e,t,n){var r=[],i;n=!!n;for(var s=0,o=e.length;s<o;s++)i=!!t(e[s],s),n!==i&&r.push(e[s]);return r},map:function(e,n,r){var s,o,u=[],a=0,f=e.length,l=e instanceof i||f!==t&&typeof f=="number"&&(f>0&&e[0]&&e[f-1]||f===0||i.isArray(e));if(l)for(;a<f;a++)s=n(e[a],a,r),s!=null&&(u[u.length]=s);else for(o in e)s=n(e[o],o,r),s!=null&&(u[u.length]=s);return u.concat.apply([],u)},guid:1,proxy:function(e,n){if(typeof n=="string"){var r=e[n];n=e,e=r}if(!i.isFunction(e))return t;var s=M.call(arguments,2),o=function(){return e.apply(n,s.concat(M.call(arguments)))};return o.guid=e.guid=e.guid||o.guid||i.guid++,o},access:function(e,n,r,s,o,u){var a=e.length;if(typeof n=="object"){for(var f in n)i.access(e,f,n[f],s,o,r);return e}if(r!==t){s=!u&&s&&i.isFunction(r);for(var l=0;l<a;l++)o(e[l],n,s?r.call(e[l],l,o(e[l],n)):r,u);return e}return a?o(e[0],n):t},now:function(){return(new Date).getTime()},uaMatch:function(e){e=e.toLowerCase();var t=g.exec(e)||y.exec(e)||b.exec(e)||e.indexOf("compatible")<0&&w.exec(e)||[];return{browser:t[1]||"",version:t[2]||"0"}},sub:function(){function e(t,n){return new e.fn.init(t,n)}i.extend(!0,e,this),e.superclass=this,e.fn=e.prototype=this(),e.fn.constructor=e,e.sub=this.sub,e.fn.init=function(r,s){return s&&s instanceof i&&!(s instanceof e)&&(s=e(s)),i.fn.init.call(this,r,s,t)},e.fn.init.prototype=e.fn;var t=e(n);return e},browser:{}}),i.each("Boolean Number String Function Array Date RegExp Object".split(" "),function(e,t){P["[object "+t+"]"]=t.toLowerCase()}),N=i.uaMatch(T),N.browser&&(i.browser[N.browser]=!0,i.browser.version=N.version),i.browser.webkit&&(i.browser.safari=!0),f.test(" ")&&(l=/^[\s\xA0]+/,c=/[\s\xA0]+$/),u=i(n),n.addEventListener?k=function(){n.removeEventListener("DOMContentLoaded",k,!1),i.ready()}:n.attachEvent&&(k=function(){n.readyState==="complete"&&(n.detachEvent("onreadystatechange",k),i.ready())}),i}(),o={};s.Callbacks=function(e){e=e?o[e]||u(e):{};var n=[],r=[],i,a,f,l,c,h=function(t){var r,i,o,u,a;for(r=0,i=t.length;r<i;r++)o=t[r],u=s.type(o),u==="array"?h(o):u==="function"&&(!e.unique||!d.has(o))&&n.push(o)},p=function(t,s){s=s||[],i=!e.memory||[t,s],a=!0,c=f||0,f=0,l=n.length;for(;n&&c<l;c++)if(n[c].apply(t,s)===!1&&e.stopOnFalse){i=!0;break}a=!1,n&&(e.once?i===!0?d.disable():n=[]:r&&r.length&&(i=r.shift(),d.fireWith(i[0],i[1])))},d={add:function(){if(n){var e=n.length;h(arguments),a?l=n.length:i&&i!==!0&&(f=e,p(i[0],i[1]))}return this},remove:function(){if(n){var t=arguments,r=0,i=t.length;for(;r<i;r++)for(var s=0;s<n.length;s++)if(t[r]===n[s]){a&&s<=l&&(l--,s<=c&&c--),n.splice(s--,1);if(e.unique)break}}return this},has:function(e){if(n){var t=0,r=n.length;for(;t<r;t++)if(e===n[t])return!0}return!1},empty:function(){return n=[],this},disable:function(){return n=r=i=t,this},disabled:function(){return!n},lock:function(){return r=t,(!i||i===!0)&&d.disable(),this},locked:function(){return!r},fireWith:function(t,n){return r&&(a?e.once||r.push([t,n]):(!e.once||!i)&&p(t,n)),this},fire:function(){return d.fireWith(this,arguments),this},fired:function(){return!!i}};return d};var a=[].slice;s.extend({Deferred:function(e){var t=s.Callbacks("once memory"),n=s.Callbacks("once memory"),r=s.Callbacks("memory"),i="pending",o={resolve:t,reject:n,notify:r},u={done:t.add,fail:n.add,progress:r.add,state:function(){return i},isResolved:t.fired,isRejected:n.fired,then:function(e,t,n){return a.done(e).fail(t).progress(n),this},always:function(){return a.done.apply(a,arguments).fail.apply(a,arguments),this},pipe:function(e,t,n){return s.Deferred(function(r){s.each({done:[e,"resolve"],fail:[t,"reject"],progress:[n,"notify"]},function(e,t){var n=t[0],i=t[1],o;s.isFunction(n)?a[e](function(){o=n.apply(this,arguments),o&&s.isFunction(o.promise)?o.promise().then(r.resolve,r.reject,r.notify):r[i+"With"](this===a?r:this,[o])}):a[e](r[i])})}).promise()},promise:function(e){if(e==null)e=u;else for(var t in u)e[t]=u[t];return e}},a=u.promise({}),f;for(f in o)a[f]=o[f].fire,a[f+"With"]=o[f].fireWith;return a.done(function(){i="resolved"},n.disable,r.lock).fail(function(){i="rejected"},t.disable,r.lock),e&&e.call(a,a),a},when:function(e){function c(e){return function(n){t[e]=arguments.length>1?a.call(arguments,0):n,--o||f.resolveWith(f,t)}}function h(e){return function(t){i[e]=arguments.length>1?a.call(arguments,0):t,f.notifyWith(l,i)}}var t=a.call(arguments,0),n=0,r=t.length,i=new Array(r),o=r,u=r,f=r<=1&&e&&s.isFunction(e.promise)?e:s.Deferred(),l=f.promise();if(r>1){for(;n<r;n++)t[n]&&t[n].promise&&s.isFunction(t[n].promise)?t[n].promise().then(c(n),f.reject,h(n)):--o;o||f.resolveWith(f,t)}else f!==e&&f.resolveWith(f,r?[e]:[]);return l}}),s.support=function(){var t,r,i,o,u,a,f,l,c,h,p,d,v,m=n.createElement("div"),g=n.documentElement;m.setAttribute("className","t"),m.innerHTML="   <link/><table></table><a href='/a' style='top:1px;float:left;opacity:.55;'>a</a><input type='checkbox'/>",r=m.getElementsByTagName("*"),i=m.getElementsByTagName("a")[0];if(!r||!r.length||!i)return{};o=n.createElement("select"),u=o.appendChild(n.createElement("option")),a=m.getElementsByTagName("input")[0],t={leadingWhitespace:m.firstChild.nodeType===3,tbody:!m.getElementsByTagName("tbody").length,htmlSerialize:!!m.getElementsByTagName("link").length,style:/top/.test(i.getAttribute("style")),hrefNormalized:i.getAttribute("href")==="/a",opacity:/^0.55/.test(i.style.opacity),cssFloat:!!i.style.cssFloat,checkOn:a.value==="on",optSelected:u.selected,getSetAttribute:m.className!=="t",enctype:!!n.createElement("form").enctype,html5Clone:n.createElement("nav").cloneNode(!0).outerHTML!=="<:nav></:nav>",submitBubbles:!0,changeBubbles:!0,focusinBubbles:!1,deleteExpando:!0,noCloneEvent:!0,inlineBlockNeedsLayout:!1,shrinkWrapBlocks:!1,reliableMarginRight:!0},a.checked=!0,t.noCloneChecked=a.cloneNode(!0).checked,o.disabled=!0,t.optDisabled=!u.disabled;try{delete m.test}catch(y){t.deleteExpando=!1}!m.addEventListener&&m.attachEvent&&m.fireEvent&&(m.attachEvent("onclick",function(){t.noCloneEvent=!1}),m.cloneNode(!0).fireEvent("onclick")),a=n.createElement("input"),a.value="t",a.setAttribute("type","radio"),t.radioValue=a.value==="t",a.setAttribute("checked","checked"),m.appendChild(a),l=n.createDocumentFragment(),l.appendChild(m.lastChild),t.checkClone=l.cloneNode(!0).cloneNode(!0).lastChild.checked,t.appendChecked=a.checked,l.removeChild(a),l.appendChild(m),m.innerHTML="",e.getComputedStyle&&(f=n.createElement("div"),f.style.width="0",f.style.marginRight="0",m.style.width="2px",m.appendChild(f),t.reliableMarginRight=(parseInt((e.getComputedStyle(f,null)||{marginRight:0}).marginRight,10)||0)===0);if(m.attachEvent)for(d in{submit:1,change:1,focusin:1})p="on"+d,v=p in m,v||(m.setAttribute(p,"return;"),v=typeof m[p]=="function"),t[d+"Bubbles"]=v;return l.removeChild(m),l=o=u=f=m=a=null,s(function(){var e,r,i,o,u,a,f,l,h,p,d,g=n.getElementsByTagName("body")[0];if(!g)return;f=1,l="position:absolute;top:0;left:0;width:1px;height:1px;margin:0;",h="visibility:hidden;border:0;",p="style='"+l+"border:5px solid #000;padding:0;'",d="<div "+p+"><div></div></div>"+"<table "+p+" cellpadding='0' cellspacing='0'>"+"<tr><td></td></tr></table>",e=n.createElement("div"),e.style.cssText=h+"width:0;height:0;position:static;top:0;margin-top:"+f+"px",g.insertBefore(e,g.firstChild),m=n.createElement("div"),e.appendChild(m),m.innerHTML="<table><tr><td style='padding:0;border:0;display:none'></td><td>t</td></tr></table>",c=m.getElementsByTagName("td"),v=c[0].offsetHeight===0,c[0].style.display="",c[1].style.display="none",t.reliableHiddenOffsets=v&&c[0].offsetHeight===0,m.innerHTML="",m.style.width=m.style.paddingLeft="1px",s.boxModel=t.boxModel=m.offsetWidth===2,typeof m.style.zoom!="undefined"&&(m.style.display="inline",m.style.zoom=1,t.inlineBlockNeedsLayout=m.offsetWidth===2,m.style.display="",m.innerHTML="<div style='width:4px;'></div>",t.shrinkWrapBlocks=m.offsetWidth!==2),m.style.cssText=l+h,m.innerHTML=d,r=m.firstChild,i=r.firstChild,u=r.nextSibling.firstChild.firstChild,a={doesNotAddBorder:i.offsetTop!==5,doesAddBorderForTableAndCells:u.offsetTop===5},i.style.position="fixed",i.style.top="20px",a.fixedPosition=i.offsetTop===20||i.offsetTop===15,i.style.position=i.style.top="",r.style.overflow="hidden",r.style.position="relative",a.subtractsBorderForOverflowNotVisible=i.offsetTop===-5,a.doesNotIncludeMarginInBodyOffset=g.offsetTop!==f,g.removeChild(e),m=e=null,s.extend(t,a)}),t}();var f=/^(?:\{.*\}|\[.*\])$/,l=/([A-Z])/g;s.extend({cache:{},uuid:0,expando:"jQuery"+(s.fn.jquery+Math.random()).replace(/\D/g,""),noData:{embed:!0,object:"clsid:D27CDB6E-AE6D-11cf-96B8-444553540000",applet:!0},hasData:function(e){return e=e.nodeType?s.cache[e[s.expando]]:e[s.expando],!!e&&!h(e)},data:function(e,n,r,i){if(!s.acceptData(e))return;var o,u,a,f=s.expando,l=typeof n=="string",c=e.nodeType,h=c?s.cache:e,p=c?e[f]:e[f]&&f,d=n==="events";if((!p||!h[p]||!d&&!i&&!h[p].data)&&l&&r===t)return;p||(c?e[f]=p=++s.uuid:p=f),h[p]||(h[p]={},c||(h[p].toJSON=s.noop));if(typeof n=="object"||typeof n=="function")i?h[p]=s.extend(h[p],n):h[p].data=s.extend(h[p].data,n);return o=u=h[p],i||(u.data||(u.data={}),u=u.data),r!==t&&(u[s.camelCase(n)]=r),d&&!u[n]?o.events:(l?(a=u[n],a==null&&(a=u[s.camelCase(n)])):a=u,a)},removeData:function(e,t,n){if(!s.acceptData(e))return;var r,i,o,u=s.expando,a=e.nodeType,f=a?s.cache:e,l=a?e[u]:u;if(!f[l])return;if(t){r=n?f[l]:f[l].data;if(r){s.isArray(t)||(t in r?t=[t]:(t=s.camelCase(t),t in r?t=[t]:t=t.split(" ")));for(i=0,o=t.length;i<o;i++)delete r[t[i]];if(!(n?h:s.isEmptyObject)(r))return}}if(!n){delete f[l].data;if(!h(f[l]))return}s.support.deleteExpando||!f.setInterval?delete f[l]:f[l]=null,a&&(s.support.deleteExpando?delete e[u]:e.removeAttribute?e.removeAttribute(u):e[u]=null)},_data:function(e,t,n){return s.data(e,t,n,!0)},acceptData:function(e){if(e.nodeName){var t=s.noData[e.nodeName.toLowerCase()];if(t)return t!==!0&&e.getAttribute("classid")===t}return!0}}),s.fn.extend({data:function(e,n){var r,i,o,u=null;if(typeof e=="undefined"){if(this.length){u=s.data(this[0]);if(this[0].nodeType===1&&!s._data(this[0],"parsedAttrs")){i=this[0].attributes;for(var a=0,f=i.length;a<f;a++)o=i[a].name,o.indexOf("data-")===0&&(o=s.camelCase(o.substring(5)),c(this[0],o,u[o]));s._data(this[0],"parsedAttrs",!0)}}return u}return typeof e=="object"?this.each(function(){s.data(this,e)}):(r=e.split("."),r[1]=r[1]?"."+r[1]:"",n===t?(u=this.triggerHandler("getData"+r[1]+"!",[r[0]]),u===t&&this.length&&(u=s.data(this[0],e),u=c(this[0],e,u)),u===t&&r[1]?this.data(r[0]):u):this.each(function(){var t=s(this),i=[r[0],n];t.triggerHandler("setData"+r[1]+"!",i),s.data(this,e,n),t.triggerHandler("changeData"+r[1]+"!",i)}))},removeData:function(e){return this.each(function(){s.removeData(this,e)})}}),s.extend({_mark:function(e,t){e&&(t=(t||"fx")+"mark",s._data(e,t,(s._data(e,t)||0)+1))},_unmark:function(e,t,n){e!==!0&&(n=t,t=e,e=!1);if(t){n=n||"fx";var r=n+"mark",i=e?0:(s._data(t,r)||1)-1;i?s._data(t,r,i):(s.removeData(t,r,!0),p(t,n,"mark"))}},queue:function(e,t,n){var r;if(e)return t=(t||"fx")+"queue",r=s._data(e,t),n&&(!r||s.isArray(n)?r=s._data(e,t,s.makeArray(n)):r.push(n)),r||[]},dequeue:function(e,t){t=t||"fx";var n=s.queue(e,t),r=n.shift(),i={};r==="inprogress"&&(r=n.shift()),r&&(t==="fx"&&n.unshift("inprogress"),s._data(e,t+".run",i),r.call(e,function(){s.dequeue(e,t)},i)),n.length||(s.removeData(e,t+"queue "+t+".run",!0),p(e,t,"queue"))}}),s.fn.extend({queue:function(e,n){return typeof e!="string"&&(n=e,e="fx"),n===t?s.queue(this[0],e):this.each(function(){var t=s.queue(this,e,n);e==="fx"&&t[0]!=="inprogress"&&s.dequeue(this,e)})},dequeue:function(e){return this.each(function(){s.dequeue(this,e)})},delay:function(e,t){return e=s.fx?s.fx.speeds[e]||e:e,t=t||"fx",this.queue(t,function(t,n){var r=setTimeout(t,e);n.stop=function(){clearTimeout(r)}})},clearQueue:function(e){return this.queue(e||"fx",[])},promise:function(e,n){function h(){--u||r.resolveWith(i,[i])}typeof e!="string"&&(n=e,e=t),e=e||"fx";var r=s.Deferred(),i=this,o=i.length,u=1,a=e+"defer",f=e+"queue",l=e+"mark",c;while(o--)if(c=s.data(i[o],a,t,!0)||(s.data(i[o],f,t,!0)||s.data(i[o],l,t,!0))&&s.data(i[o],a,s.Callbacks("once memory"),!0))u++,c.add(h);return h(),r.promise()}});var d=/[\n\t\r]/g,v=/\s+/,m=/\r/g,g=/^(?:button|input)$/i,y=/^(?:button|input|object|select|textarea)$/i,b=/^a(?:rea)?$/i,w=/^(?:autofocus|autoplay|async|checked|controls|defer|disabled|hidden|loop|multiple|open|readonly|required|scoped|selected)$/i,E=s.support.getSetAttribute,S,x,T;s.fn.extend({attr:function(e,t){return s.access(this,e,t,!0,s.attr)},removeAttr:function(e){return this.each(function(){s.removeAttr(this,e)})},prop:function(e,t){return s.access(this,e,t,!0,s.prop)},removeProp:function(e){return e=s.propFix[e]||e,this.each(function(){try{this[e]=t,delete this[e]}catch(n){}})},addClass:function(e){var t,n,r,i,o,u,a;if(s.isFunction(e))return this.each(function(t){s(this).addClass(e.call(this,t,this.className))});if(e&&typeof e=="string"){t=e.split(v);for(n=0,r=this.length;n<r;n++){i=this[n];if(i.nodeType===1)if(!i.className&&t.length===1)i.className=e;else{o=" "+i.className+" ";for(u=0,a=t.length;u<a;u++)~o.indexOf(" "+t[u]+" ")||(o+=t[u]+" ");i.className=s.trim(o)}}}return this},removeClass:function(e){var n,r,i,o,u,a,f;if(s.isFunction(e))return this.each(function(t){s(this).removeClass(e.call(this,t,this.className))});if(e&&typeof e=="string"||e===t){n=(e||"").split(v);for(r=0,i=this.length;r<i;r++){o=this[r];if(o.nodeType===1&&o.className)if(e){u=(" "+o.className+" ").replace(d," ");for(a=0,f=n.length;a<f;a++)u=u.replace(" "+n[a]+" "," ");o.className=s.trim(u)}else o.className=""}}return this},toggleClass:function(e,t){var n=typeof e,r=typeof t=="boolean";return s.isFunction(e)?this.each(function(n){s(this).toggleClass(e.call(this,n,this.className,t),t)}):this.each(function(){if(n==="string"){var i,o=0,u=s(this),a=t,f=e.split(v);while(i=f[o++])a=r?a:!u.hasClass(i),u[a?"addClass":"removeClass"](i)}else if(n==="undefined"||n==="boolean")this.className&&s._data(this,"__className__",this.className),this.className=this.className||e===!1?"":s._data(this,"__className__")||""})},hasClass:function(e){var t=" "+e+" ",n=0,r=this.length;for(;n<r;n++)if(this[n].nodeType===1&&(" "+this[n].className+" ").replace(d," ").indexOf(t)>-1)return!0;return!1},val:function(e){var n,r,i,o=this[0];if(!arguments.length){if(o)return n=s.valHooks[o.nodeName.toLowerCase()]||s.valHooks[o.type],n&&"get"in n&&(r=n.get(o,"value"))!==t?r:(r=o.value,typeof r=="string"?r.replace(m,""):r==null?"":r);return}return i=s.isFunction(e),this.each(function(r){var o=s(this),u;if(this.nodeType!==1)return;i?u=e.call(this,r,o.val()):u=e,u==null?u="":typeof u=="number"?u+="":s.isArray(u)&&(u=s.map(u,function(e){return e==null?"":e+""})),n=s.valHooks[this.nodeName.toLowerCase()]||s.valHooks[this.type];if(!n||!("set"in n)||n.set(this,u,"value")===t)this.value=u})}}),s.extend({valHooks:{option:{get:function(e){var t=e.attributes.value;return!t||t.specified?e.value:e.text}},select:{get:function(e){var t,n,r,i,o=e.selectedIndex,u=[],a=e.options,f=e.type==="select-one";if(o<0)return null;n=f?o:0,r=f?o+1:a.length;for(;n<r;n++){i=a[n];if(i.selected&&(s.support.optDisabled?!i.disabled:i.getAttribute("disabled")===null)&&(!i.parentNode.disabled||!s.nodeName(i.parentNode,"optgroup"))){t=s(i).val();if(f)return t;u.push(t)}}return f&&!u.length&&a.length?s(a[o]).val():u},set:function(e,t){var n=s.makeArray(t);return s(e).find("option").each(function(){this.selected=s.inArray(s(this).val(),n)>=0}),n.length||(e.selectedIndex=-1),n}}},attrFn:{val:!0,css:!0,html:!0,text:!0,data:!0,width:!0,height:!0,offset:!0},attr:function(e,n,r,i){var o,u,a,f=e.nodeType;if(!e||f===3||f===8||f===2)return;if(i&&n in s.attrFn)return s(e)[n](r);if(typeof e.getAttribute=="undefined")return s.prop(e,n,r);a=f!==1||!s.isXMLDoc(e),a&&(n=n.toLowerCase(),u=s.attrHooks[n]||(w.test(n)?x:S));if(r!==t){if(r===null){s.removeAttr(e,n);return}return u&&"set"in u&&a&&(o=u.set(e,r,n))!==t?o:(e.setAttribute(n,""+r),r)}return u&&"get"in u&&a&&(o=u.get(e,n))!==null?o:(o=e.getAttribute(n),o===null?t:o)},removeAttr:function(e,t){var n,r,i,o,u=0;if(t&&e.nodeType===1){r=t.toLowerCase().split(v),o=r.length;for(;u<o;u++)i=r[u],i&&(n=s.propFix[i]||i,s.attr(e,i,""),e.removeAttribute(E?i:n),w.test(i)&&n in e&&(e[n]=!1))}},attrHooks:{type:{set:function(e,t){if(g.test(e.nodeName)&&e.parentNode)s.error("type property can't be changed");else if(!s.support.radioValue&&t==="radio"&&s.nodeName(e,"input")){var n=e.value;return e.setAttribute("type",t),n&&(e.value=n),t}}},value:{get:function(e,t){return S&&s.nodeName(e,"button")?S.get(e,t):t in e?e.value:null},set:function(e,t,n){if(S&&s.nodeName(e,"button"))return S.set(e,t,n);e.value=t}}},propFix:{tabindex:"tabIndex",readonly:"readOnly","for":"htmlFor","class":"className",maxlength:"maxLength",cellspacing:"cellSpacing",cellpadding:"cellPadding",rowspan:"rowSpan",colspan:"colSpan",usemap:"useMap",frameborder:"frameBorder",contenteditable:"contentEditable"},prop:function(e,n,r){var i,o,u,a=e.nodeType;if(!e||a===3||a===8||a===2)return;return u=a!==1||!s.isXMLDoc(e),u&&(n=s.propFix[n]||n,o=s.propHooks[n]),r!==t?o&&"set"in o&&(i=o.set(e,r,n))!==t?i:e[n]=r:o&&"get"in o&&(i=o.get(e,n))!==null?i:e[n]},propHooks:{tabIndex:{get:function(e){var n=e.getAttributeNode("tabindex");return n&&n.specified?parseInt(n.value,10):y.test(e.nodeName)||b.test(e.nodeName)&&e.href?0:t}}}}),s.attrHooks.tabindex=s.propHooks.tabIndex,x={get:function(e,n){var r,i=s.prop(e,n);return i===!0||typeof i!="boolean"&&(r=e.getAttributeNode(n))&&r.nodeValue!==!1?n.toLowerCase():t},set:function(e,t,n){var r;return t===!1?s.removeAttr(e,n):(r=s.propFix[n]||n,r in e&&(e[r]=!0),e.setAttribute(n,n.toLowerCase())),n}},E||(T={name:!0,id:!0},S=s.valHooks.button={get:function(e,n){var r;return r=e.getAttributeNode(n),r&&(T[n]?r.nodeValue!=="":r.specified)?r.nodeValue:t},set:function(e,t,r){var i=e.getAttributeNode(r);return i||(i=n.createAttribute(r),e.setAttributeNode(i)),i.nodeValue=t+""}},s.attrHooks.tabindex.set=S.set,s.each(["width","height"],function(e,t){s.attrHooks[t]=s.extend(s.attrHooks[t],{set:function(e,n){if(n==="")return e.setAttribute(t,"auto"),n}})}),s.attrHooks.contenteditable={get:S.get,set:function(e,t,n){t===""&&(t="false"),S.set(e,t,n)}}),s.support.hrefNormalized||s.each(["href","src","width","height"],function(e,n){s.attrHooks[n]=s.extend(s.attrHooks[n],{get:function(e){var r=e.getAttribute(n,2);return r===null?t:r}})}),s.support.style||(s.attrHooks.style={get:function(e){return e.style.cssText.toLowerCase()||t},set:function(e,t){return e.style.cssText=""+t}}),s.support.optSelected||(s.propHooks.selected=s.extend(s.propHooks.selected,{get:function(e){var t=e.parentNode;return t&&(t.selectedIndex,t.parentNode&&t.parentNode.selectedIndex),null}})),s.support.enctype||(s.propFix.enctype="encoding"),s.support.checkOn||s.each(["radio","checkbox"],function(){s.valHooks[this]={get:function(e){return e.getAttribute("value")===null?"on":e.value}}}),s.each(["radio","checkbox"],function(){s.valHooks[this]=s.extend(s.valHooks[this],{set:function(e,t){if(s.isArray(t))return e.checked=s.inArray(s(e).val(),t)>=0}})});var N=/^(?:textarea|input|select)$/i,C=/^([^\.]*)?(?:\.(.+))?$/,k=/\bhover(\.\S+)?\b/,L=/^key/,A=/^(?:mouse|contextmenu)|click/,O=/^(?:focusinfocus|focusoutblur)$/,M=/^(\w*)(?:#([\w\-]+))?(?:\.([\w\-]+))?$/,_=function(e){var t=M.exec(e);return t&&(t[1]=(t[1]||"").toLowerCase(),t[3]=t[3]&&new RegExp("(?:^|\\s)"+t[3]+"(?:\\s|$)")),t},D=function(e,t){var n=e.attributes||{};return(!t[1]||e.nodeName.toLowerCase()===t[1])&&(!t[2]||(n.id||{}).value===t[2])&&(!t[3]||t[3].test((n["class"]||{}).value))},P=function(e){return s.event.special.hover?e:e.replace(k,"mouseenter$1 mouseleave$1")};s.event={add:function(e,n,r,i,o){var u,a,f,l,c,h,p,d,v,m,g,y;if(e.nodeType===3||e.nodeType===8||!n||!r||!(u=s._data(e)))return;r.handler&&(v=r,r=v.handler),r.guid||(r.guid=s.guid++),f=u.events,f||(u.events=f={}),a=u.handle,a||(u.handle=a=function(e){return typeof s=="undefined"||!!e&&s.event.triggered===e.type?t:s.event.dispatch.apply(a.elem,arguments)},a.elem=e),n=s.trim(P(n)).split(" ");for(l=0;l<n.length;l++){c=C.exec(n[l])||[],h=c[1],p=(c[2]||"").split(".").sort(),y=s.event.special[h]||{},h=(o?y.delegateType:y.bindType)||h,y=s.event.special[h]||{},d=s.extend({type:h,origType:c[1],data:i,handler:r,guid:r.guid,selector:o,quick:_(o),namespace:p.join(".")},v),g=f[h];if(!g){g=f[h]=[],g.delegateCount=0;if(!y.setup||y.setup.call(e,i,p,a)===!1)e.addEventListener?e.addEventListener(h,a,!1):e.attachEvent&&e.attachEvent("on"+h,a)}y.add&&(y.add.call(e,d),d.handler.guid||(d.handler.guid=r.guid)),o?g.splice(g.delegateCount++,0,d):g.push(d),s.event.global[h]=!0}e=null},global:{},remove:function(e,t,n,r,i){var o=s.hasData(e)&&s._data(e),u,a,f,l,c,h,p,d,v,m,g,y;if(!o||!(d=o.events))return;t=s.trim(P(t||"")).split(" ");for(u=0;u<t.length;u++){a=C.exec(t[u])||[],f=l=a[1],c=a[2];if(!f){for(f in d)s.event.remove(e,f+t[u],n,r,!0);continue}v=s.event.special[f]||{},f=(r?v.delegateType:v.bindType)||f,g=d[f]||[],h=g.length,c=c?new RegExp("(^|\\.)"+c.split(".").sort().join("\\.(?:.*\\.)?")+"(\\.|$)"):null;for(p=0;p<g.length;p++)y=g[p],(i||l===y.origType)&&(!n||n.guid===y.guid)&&(!c||c.test(y.namespace))&&(!r||r===y.selector||r==="**"&&y.selector)&&(g.splice(p--,1),y.selector&&g.delegateCount--,v.remove&&v.remove.call(e,y));g.length===0&&h!==g.length&&((!v.teardown||v.teardown.call(e,c)===!1)&&s.removeEvent(e,f,o.handle),delete d[f])}s.isEmptyObject(d)&&(m=o.handle,m&&(m.elem=null),s.removeData(e,["events","handle"],!0))},customEvent:{getData:!0,setData:!0,changeData:!0},trigger:function(n,r,i,o){if(!i||i.nodeType!==3&&i.nodeType!==8){var u=n.type||n,a=[],f,l,c,h,p,d,v,m,g,y;if(O.test(u+s.event.triggered))return;u.indexOf("!")>=0&&(u=u.slice(0,-1),l=!0),u.indexOf(".")>=0&&(a=u.split("."),u=a.shift(),a.sort());if((!i||s.event.customEvent[u])&&!s.event.global[u])return;n=typeof n=="object"?n[s.expando]?n:new s.Event(u,n):new s.Event(u),n.type=u,n.isTrigger=!0,n.exclusive=l,n.namespace=a.join("."),n.namespace_re=n.namespace?new RegExp("(^|\\.)"+a.join("\\.(?:.*\\.)?")+"(\\.|$)"):null,d=u.indexOf(":")<0?"on"+u:"";if(!i){f=s.cache;for(c in f)f[c].events&&f[c].events[u]&&s.event.trigger(n,r,f[c].handle.elem,!0);return}n.result=t,n.target||(n.target=i),r=r!=null?s.makeArray(r):[],r.unshift(n),v=s.event.special[u]||{};if(v.trigger&&v.trigger.apply(i,r)===!1)return;g=[[i,v.bindType||u]];if(!o&&!v.noBubble&&!s.isWindow(i)){y=v.delegateType||u,h=O.test(y+u)?i:i.parentNode,p=null;for(;h;h=h.parentNode)g.push([h,y]),p=h;p&&p===i.ownerDocument&&g.push([p.defaultView||p.parentWindow||e,y])}for(c=0;c<g.length&&!n.isPropagationStopped();c++)h=g[c][0],n.type=g[c][1],m=(s._data(h,"events")||{})[n.type]&&s._data(h,"handle"),m&&m.apply(h,r),m=d&&h[d],m&&s.acceptData(h)&&m.apply(h,r)===!1&&n.preventDefault();return n.type=u,!o&&!n.isDefaultPrevented()&&(!v._default||v._default.apply(i.ownerDocument,r)===!1)&&(u!=="click"||!s.nodeName(i,"a"))&&s.acceptData(i)&&d&&i[u]&&(u!=="focus"&&u!=="blur"||n.target.offsetWidth!==0)&&!s.isWindow(i)&&(p=i[d],p&&(i[d]=null),s.event.triggered=u,i[u](),s.event.triggered=t,p&&(i[d]=p)),n.result}return},dispatch:function(n){n=s.event.fix(n||e.event);var r=(s._data(this,"events")||{})[n.type]||[],i=r.delegateCount,o=[].slice.call(arguments,0),u=!n.exclusive&&!n.namespace,a=[],f,l,c,h,p,d,v,m,g,y,b;o[0]=n,n.delegateTarget=this;if(i&&!n.target.disabled&&(!n.button||n.type!=="click")){h=s(this),h.context=this.ownerDocument||this;for(c=n.target;c!=this;c=c.parentNode||this){d={},m=[],h[0]=c;for(f=0;f<i;f++)g=r[f],y=g.selector,d[y]===t&&(d[y]=g.quick?D(c,g.quick):h.is(y)),d[y]&&m.push(g);m.length&&a.push({elem:c,matches:m})}}r.length>i&&a.push({elem:this,matches:r.slice(i)});for(f=0;f<a.length&&!n.isPropagationStopped();f++){v=a[f],n.currentTarget=v.elem;for(l=0;l<v.matches.length&&!n.isImmediatePropagationStopped();l++){g=v.matches[l];if(u||!n.namespace&&!g.namespace||n.namespace_re&&n.namespace_re.test(g.namespace))n.data=g.data,n.handleObj=g,p=((s.event.special[g.origType]||{}).handle||g.handler).apply(v.elem,o),p!==t&&(n.result=p,p===!1&&(n.preventDefault(),n.stopPropagation()))}}return n.result},props:"attrChange attrName relatedNode srcElement altKey bubbles cancelable ctrlKey currentTarget eventPhase metaKey relatedTarget shiftKey target timeStamp view which".split(" "),fixHooks:{},keyHooks:{props:"char charCode key keyCode".split(" "),filter:function(e,t){return e.which==null&&(e.which=t.charCode!=null?t.charCode:t.keyCode),e}},mouseHooks:{props:"button buttons clientX clientY fromElement offsetX offsetY pageX pageY screenX screenY toElement".split(" "),filter:function(e,r){var i,s,o,u=r.button,a=r.fromElement;return e.pageX==null&&r.clientX!=null&&(i=e.target.ownerDocument||n,s=i.documentElement,o=i.body,e.pageX=r.clientX+(s&&s.scrollLeft||o&&o.scrollLeft||0)-(s&&s.clientLeft||o&&o.clientLeft||0),e.pageY=r.clientY+(s&&s.scrollTop||o&&o.scrollTop||0)-(s&&s.clientTop||o&&o.clientTop||0)),!e.relatedTarget&&a&&(e.relatedTarget=a===e.target?r.toElement:a),!e.which&&u!==t&&(e.which=u&1?1:u&2?3:u&4?2:0),e}},fix:function(e){if(e[s.expando])return e;var r,i,o=e,u=s.event.fixHooks[e.type]||{},a=u.props?this.props.concat(u.props):this.props;e=s.Event(o);for(r=a.length;r;)i=a[--r],e[i]=o[i];return e.target||(e.target=o.srcElement||n),e.target.nodeType===3&&(e.target=e.target.parentNode),e.metaKey===t&&(e.metaKey=e.ctrlKey),u.filter?u.filter(e,o):e},special:{ready:{setup:s.bindReady},load:{noBubble:!0},focus:{delegateType:"focusin"},blur:{delegateType:"focusout"},beforeunload:{setup:function(e,t,n){s.isWindow(this)&&(this.onbeforeunload=n)},teardown:function(e,t){this.onbeforeunload===t&&(this.onbeforeunload=null)}}},simulate:function(e,t,n,r){var i=s.extend(new s.Event,n,{type:e,isSimulated:!0,originalEvent:{}});r?s.event.trigger(i,null,t):s.event.dispatch.call(t,i),i.isDefaultPrevented()&&n.preventDefault()}},s.event.handle=s.event.dispatch,s.removeEvent=n.removeEventListener?function(e,t,n){e.removeEventListener&&e.removeEventListener(t,n,!1)}:function(e,t,n){e.detachEvent&&e.detachEvent("on"+t,n)},s.Event=function(e,t){if(!(this instanceof s.Event))return new s.Event(e,t);e&&e.type?(this.originalEvent=e,this.type=e.type,this.isDefaultPrevented=e.defaultPrevented||e.returnValue===!1||e.getPreventDefault&&e.getPreventDefault()?B:H):this.type=e,t&&s.extend(this,t),this.timeStamp=e&&e.timeStamp||s.now(),this[s.expando]=!0},s.Event.prototype={preventDefault:function(){this.isDefaultPrevented=B;var e=this.originalEvent;if(!e)return;e.preventDefault?e.preventDefault():e.returnValue=!1},stopPropagation:function(){this.isPropagationStopped=B;var e=this.originalEvent;if(!e)return;e.stopPropagation&&e.stopPropagation(),e.cancelBubble=!0},stopImmediatePropagation:function(){this.isImmediatePropagationStopped=B,this.stopPropagation()},isDefaultPrevented:H,isPropagationStopped:H,isImmediatePropagationStopped:H},s.each({mouseenter:"mouseover",mouseleave:"mouseout"},function(e,t){s.event.special[e]={delegateType:t,bindType:t,handle:function(e){var n=this,r=e.relatedTarget,i=e.handleObj,o=i.selector,u;if(!r||r!==n&&!s.contains(n,r))e.type=i.origType,u=i.handler.apply(this,arguments),e.type=t;return u}}}),s.support.submitBubbles||(s.event.special.submit={setup:function(){if(s.nodeName(this,"form"))return!1;s.event.add(this,"click._submit keypress._submit",function(e){var n=e.target,r=s.nodeName(n,"input")||s.nodeName(n,"button")?n.form:t;r&&!r._submit_attached&&(s.event.add(r,"submit._submit",function(e){this.parentNode&&!e.isTrigger&&s.event.simulate("submit",this.parentNode,e,!0)}),r._submit_attached=!0)})},teardown:function(){if(s.nodeName(this,"form"))return!1;s.event.remove(this,"._submit")}}),s.support.changeBubbles||(s.event.special.change={setup:function(){if(N.test(this.nodeName)){if(this.type==="checkbox"||this.type==="radio")s.event.add(this,"propertychange._change",function(e){e.originalEvent.propertyName==="checked"&&(this._just_changed=!0)}),s.event.add(this,"click._change",function(e){this._just_changed&&!e.isTrigger&&(this._just_changed=!1,s.event.simulate("change",this,e,!0))});return!1}s.event.add(this,"beforeactivate._change",function(e){var t=e.target;N.test(t.nodeName)&&!t._change_attached&&(s.event.add(t,"change._change",function(e){this.parentNode&&!e.isSimulated&&!e.isTrigger&&s.event.simulate("change",this.parentNode,e,!0)}),t._change_attached=!0)})},handle:function(e){var t=e.target;if(this!==t||e.isSimulated||e.isTrigger||t.type!=="radio"&&t.type!=="checkbox")return e.handleObj.handler.apply(this,arguments)},teardown:function(){return s.event.remove(this,"._change"),N.test(this.nodeName)}}),s.support.focusinBubbles||s.each({focus:"focusin",blur:"focusout"},function(e,t){var r=0,i=function(e){s.event.simulate(t,e.target,s.event.fix(e),!0)};s.event.special[t]={setup:function(){r++===0&&n.addEventListener(e,i,!0)},teardown:function(){--r===0&&n.removeEventListener(e,i,!0)}}}),s.fn.extend({on:function(e,n,r,i,o){var u,a;if(typeof e=="object"){typeof n!="string"&&(r=n,n=t);for(a in e)this.on(a,n,r,e[a],o);return this}r==null&&i==null?(i=n,r=n=t):i==null&&(typeof n=="string"?(i=r,r=t):(i=r,r=n,n=t));if(i===!1)i=H;else if(!i)return this;return o===1&&(u=i,i=function(e){return s().off(e),u.apply(this,arguments)},i.guid=u.guid||(u.guid=s.guid++)),this.each(function(){s.event.add(this,e,i,r,n)})},one:function(e,t,n,r){return this.on.call(this,e,t,n,r,1)},off:function(e,n,r){if(e&&e.preventDefault&&e.handleObj){var i=e.handleObj;return s(e.delegateTarget).off(i.namespace?i.type+"."+i.namespace:i.type,i.selector,i.handler),this}if(typeof e=="object"){for(var o in e)this.off(o,n,e[o]);return this}if(n===!1||typeof n=="function")r=n,n=t;return r===!1&&(r=H),this.each(function(){s.event.remove(this,e,r,n)})},bind:function(e,t,n){return this.on(e,null,t,n)},unbind:function(e,t){return this.off(e,null,t)},live:function(e,t,n){return s(this.context).on(e,this.selector,t,n),this},die:function(e,t){return s(this.context).off(e,this.selector||"**",t),this},delegate:function(e,t,n,r){return this.on(t,e,n,r)},undelegate:function(e,t,n){return arguments.length==1?this.off(e,"**"):this.off(t,e,n)},trigger:function(e,t){return this.each(function(){s.event.trigger(e,t,this)})},triggerHandler:function(e,t){if(this[0])return s.event.trigger(e,t,this[0],!0)},toggle:function(e){var t=arguments,n=e.guid||s.guid++,r=0,i=function(n){var i=(s._data(this,"lastToggle"+e.guid)||0)%r;return s._data(this,"lastToggle"+e.guid,i+1),n.preventDefault(),t[i].apply(this,arguments)||!1};i.guid=n;while(r<t.length)t[r++].guid=n;return this.click(i)},hover:function(e,t){return this.mouseenter(e).mouseleave(t||e)}}),s.each("blur focus focusin focusout load resize scroll unload click dblclick mousedown mouseup mousemove mouseover mouseout mouseenter mouseleave change select submit keydown keypress keyup error contextmenu".split(" "),function(e,t){s.fn[t]=function(e,n){return n==null&&(n=e,e=null),arguments.length>0?this.on(t,null,e,n):this.trigger(t)},s.attrFn&&(s.attrFn[t]=!0),L.test(t)&&(s.event.fixHooks[t]=s.event.keyHooks),A.test(t)&&(s.event.fixHooks[t]=s.event.mouseHooks)}),function(){function S(e,t,n,i,s,o){for(var u=0,a=i.length;u<a;u++){var f=i[u];if(f){var l=!1;f=f[e];while(f){if(f[r]===n){l=i[f.sizset];break}f.nodeType===1&&!o&&(f[r]=n,f.sizset=u);if(f.nodeName.toLowerCase()===t){l=f;break}f=f[e]}i[u]=l}}}function x(e,t,n,i,s,o){for(var u=0,a=i.length;u<a;u++){var f=i[u];if(f){var l=!1;f=f[e];while(f){if(f[r]===n){l=i[f.sizset];break}if(f.nodeType===1){o||(f[r]=n,f.sizset=u);if(typeof t!="string"){if(f===t){l=!0;break}}else if(h.filter(t,[f]).length>0){l=f;break}}f=f[e]}i[u]=l}}}var e=/((?:\((?:\([^()]+\)|[^()]+)+\)|\[(?:\[[^\[\]]*\]|['"][^'"]*['"]|[^\[\]'"]+)+\]|\\.|[^ >+~,(\[\\]+)+|[>+~])(\s*,\s*)?((?:.|\r|\n)*)/g,r="sizcache"+(Math.random()+"").replace(".",""),i=0,o=Object.prototype.toString,u=!1,a=!0,f=/\\/g,l=/\r\n/g,c=/\W/;[0,0].sort(function(){return a=!1,0});var h=function(t,r,i,s){i=i||[],r=r||n;var u=r;if(r.nodeType!==1&&r.nodeType!==9)return[];if(!t||typeof t!="string")return i;var a,f,l,c,p,m,g,b,w=!0,E=h.isXML(r),S=[],x=t;do{e.exec(""),a=e.exec(x);if(a){x=a[3],S.push(a[1]);if(a[2]){c=a[3];break}}}while(a);if(S.length>1&&v.exec(t))if(S.length===2&&d.relative[S[0]])f=T(S[0]+S[1],r,s);else{f=d.relative[S[0]]?[r]:h(S.shift(),r);while(S.length)t=S.shift(),d.relative[t]&&(t+=S.shift()),f=T(t,f,s)}else{!s&&S.length>1&&r.nodeType===9&&!E&&d.match.ID.test(S[0])&&!d.match.ID.test(S[S.length-1])&&(p=h.find(S.shift(),r,E),r=p.expr?h.filter(p.expr,p.set)[0]:p.set[0]);if(r){p=s?{expr:S.pop(),set:y(s)}:h.find(S.pop(),S.length!==1||S[0]!=="~"&&S[0]!=="+"||!r.parentNode?r:r.parentNode,E),f=p.expr?h.filter(p.expr,p.set):p.set,S.length>0?l=y(f):w=!1;while(S.length)m=S.pop(),g=m,d.relative[m]?g=S.pop():m="",g==null&&(g=r),d.relative[m](l,g,E)}else l=S=[]}l||(l=f),l||h.error(m||t);if(o.call(l)==="[object Array]")if(!w)i.push.apply(i,l);else if(r&&r.nodeType===1)for(b=0;l[b]!=null;b++)l[b]&&(l[b]===!0||l[b].nodeType===1&&h.contains(r,l[b]))&&i.push(f[b]);else for(b=0;l[b]!=null;b++)l[b]&&l[b].nodeType===1&&i.push(f[b]);else y(l,i);return c&&(h(c,u,i,s),h.uniqueSort(i)),i};h.uniqueSort=function(e){if(w){u=a,e.sort(w);if(u)for(var t=1;t<e.length;t++)e[t]===e[t-1]&&e.splice(t--,1)}return e},h.matches=function(e,t){return h(e,null,null,t)},h.matchesSelector=function(e,t){return h(t,null,null,[e]).length>0},h.find=function(e,t,n){var r,i,s,o,u,a;if(!e)return[];for(i=0,s=d.order.length;i<s;i++){u=d.order[i];if(o=d.leftMatch[u].exec(e)){a=o[1],o.splice(1,1);if(a.substr(a.length-1)!=="\\"){o[1]=(o[1]||"").replace(f,""),r=d.find[u](o,t,n);if(r!=null){e=e.replace(d.match[u],"");break}}}}return r||(r=typeof t.getElementsByTagName!="undefined"?t.getElementsByTagName("*"):[]),{set:r,expr:e}},h.filter=function(e,n,r,i){var s,o,u,a,f,l,c,p,v,m=e,g=[],y=n,b=n&&n[0]&&h.isXML(n[0]);while(e&&n.length){for(u in d.filter)if((s=d.leftMatch[u].exec(e))!=null&&s[2]){l=d.filter[u],c=s[1],o=!1,s.splice(1,1);if(c.substr(c.length-1)==="\\")continue;y===g&&(g=[]);if(d.preFilter[u]){s=d.preFilter[u](s,y,r,g,i,b);if(!s)o=a=!0;else if(s===!0)continue}if(s)for(p=0;(f=y[p])!=null;p++)f&&(a=l(f,s,p,y),v=i^a,r&&a!=null?v?o=!0:y[p]=!1:v&&(g.push(f),o=!0));if(a!==t){r||(y=g),e=e.replace(d.match[u],"");if(!o)return[];break}}if(e===m){if(o!=null)break;h.error(e)}m=e}return y},h.error=function(e){throw new Error("Syntax error, unrecognized expression: "+e)};var p=h.getText=function(e){var t,n,r=e.nodeType,i="";if(r){if(r===1||r===9){if(typeof e.textContent=="string")return e.textContent;if(typeof e.innerText=="string")return e.innerText.replace(l,"");for(e=e.firstChild;e;e=e.nextSibling)i+=p(e)}else if(r===3||r===4)return e.nodeValue}else for(t=0;n=e[t];t++)n.nodeType!==8&&(i+=p(n));return i},d=h.selectors={order:["ID","NAME","TAG"],match:{ID:/#((?:[\w\u00c0-\uFFFF\-]|\\.)+)/,CLASS:/\.((?:[\w\u00c0-\uFFFF\-]|\\.)+)/,NAME:/\[name=['"]*((?:[\w\u00c0-\uFFFF\-]|\\.)+)['"]*\]/,ATTR:/\[\s*((?:[\w\u00c0-\uFFFF\-]|\\.)+)\s*(?:(\S?=)\s*(?:(['"])(.*?)\3|(#?(?:[\w\u00c0-\uFFFF\-]|\\.)*)|)|)\s*\]/,TAG:/^((?:[\w\u00c0-\uFFFF\*\-]|\\.)+)/,CHILD:/:(only|nth|last|first)-child(?:\(\s*(even|odd|(?:[+\-]?\d+|(?:[+\-]?\d*)?n\s*(?:[+\-]\s*\d+)?))\s*\))?/,POS:/:(nth|eq|gt|lt|first|last|even|odd)(?:\((\d*)\))?(?=[^\-]|$)/,PSEUDO:/:((?:[\w\u00c0-\uFFFF\-]|\\.)+)(?:\((['"]?)((?:\([^\)]+\)|[^\(\)]*)+)\2\))?/},leftMatch:{},attrMap:{"class":"className","for":"htmlFor"},attrHandle:{href:function(e){return e.getAttribute("href")},type:function(e){return e.getAttribute("type")}},relative:{"+":function(e,t){var n=typeof t=="string",r=n&&!c.test(t),i=n&&!r;r&&(t=t.toLowerCase());for(var s=0,o=e.length,u;s<o;s++)if(u=e[s]){while((u=u.previousSibling)&&u.nodeType!==1);e[s]=i||u&&u.nodeName.toLowerCase()===t?u||!1:u===t}i&&h.filter(t,e,!0)},">":function(e,t){var n,r=typeof t=="string",i=0,s=e.length;if(r&&!c.test(t)){t=t.toLowerCase();for(;i<s;i++){n=e[i];if(n){var o=n.parentNode;e[i]=o.nodeName.toLowerCase()===t?o:!1}}}else{for(;i<s;i++)n=e[i],n&&(e[i]=r?n.parentNode:n.parentNode===t);r&&h.filter(t,e,!0)}},"":function(e,t,n){var r,s=i++,o=x;typeof t=="string"&&!c.test(t)&&(t=t.toLowerCase(),r=t,o=S),o("parentNode",t,s,e,r,n)},"~":function(e,t,n){var r,s=i++,o=x;typeof t=="string"&&!c.test(t)&&(t=t.toLowerCase(),r=t,o=S),o("previousSibling",t,s,e,r,n)}},find:{ID:function(e,t,n){if(typeof t.getElementById!="undefined"&&!n){var r=t.getElementById(e[1]);return r&&r.parentNode?[r]:[]}},NAME:function(e,t){if(typeof t.getElementsByName!="undefined"){var n=[],r=t.getElementsByName(e[1]);for(var i=0,s=r.length;i<s;i++)r[i].getAttribute("name")===e[1]&&n.push(r[i]);return n.length===0?null:n}},TAG:function(e,t){if(typeof t.getElementsByTagName!="undefined")return t.getElementsByTagName(e[1])}},preFilter:{CLASS:function(e,t,n,r,i,s){e=" "+e[1].replace(f,"")+" ";if(s)return e;for(var o=0,u;(u=t[o])!=null;o++)u&&(i^(u.className&&(" "+u.className+" ").replace(/[\t\n\r]/g," ").indexOf(e)>=0)?n||r.push(u):n&&(t[o]=!1));return!1},ID:function(e){return e[1].replace(f,"")},TAG:function(e,t){return e[1].replace(f,"").toLowerCase()},CHILD:function(e){if(e[1]==="nth"){e[2]||h.error(e[0]),e[2]=e[2].replace(/^\+|\s*/g,"");var t=/(-?)(\d*)(?:n([+\-]?\d*))?/.exec(e[2]==="even"&&"2n"||e[2]==="odd"&&"2n+1"||!/\D/.test(e[2])&&"0n+"+e[2]||e[2]);e[2]=t[1]+(t[2]||1)-0,e[3]=t[3]-0}else e[2]&&h.error(e[0]);return e[0]=i++,e},ATTR:function(e,t,n,r,i,s){var o=e[1]=e[1].replace(f,"");return!s&&d.attrMap[o]&&(e[1]=d.attrMap[o]),e[4]=(e[4]||e[5]||"").replace(f,""),e[2]==="~="&&(e[4]=" "+e[4]+" "),e},PSEUDO:function(t,n,r,i,s){if(t[1]==="not"){if(!((e.exec(t[3])||"").length>1||/^\w/.test(t[3]))){var o=h.filter(t[3],n,r,!0^s);return r||i.push.apply(i,o),!1}t[3]=h(t[3],null,null,n)}else if(d.match.POS.test(t[0])||d.match.CHILD.test(t[0]))return!0;return t},POS:function(e){return e.unshift(!0),e}},filters:{enabled:function(e){return e.disabled===!1&&e.type!=="hidden"},disabled:function(e){return e.disabled===!0},checked:function(e){return e.checked===!0},selected:function(e){return e.parentNode&&e.parentNode.selectedIndex,e.selected===!0},parent:function(e){return!!e.firstChild},empty:function(e){return!e.firstChild},has:function(e,t,n){return!!h(n[3],e).length},header:function(e){return/h\d/i.test(e.nodeName)},text:function(e){var t=e.getAttribute("type"),n=e.type;return e.nodeName.toLowerCase()==="input"&&"text"===n&&(t===n||t===null)},radio:function(e){return e.nodeName.toLowerCase()==="input"&&"radio"===e.type},checkbox:function(e){return e.nodeName.toLowerCase()==="input"&&"checkbox"===e.type},file:function(e){return e.nodeName.toLowerCase()==="input"&&"file"===e.type},password:function(e){return e.nodeName.toLowerCase()==="input"&&"password"===e.type},submit:function(e){var t=e.nodeName.toLowerCase();return(t==="input"||t==="button")&&"submit"===e.type},image:function(e){return e.nodeName.toLowerCase()==="input"&&"image"===e.type},reset:function(e){var t=e.nodeName.toLowerCase();return(t==="input"||t==="button")&&"reset"===e.type},button:function(e){var t=e.nodeName.toLowerCase();return t==="input"&&"button"===e.type||t==="button"},input:function(e){return/input|select|textarea|button/i.test(e.nodeName)},focus:function(e){return e===e.ownerDocument.activeElement}},setFilters:{first:function(e,t){return t===0},last:function(e,t,n,r){return t===r.length-1},even:function(e,t){return t%2===0},odd:function(e,t){return t%2===1},lt:function(e,t,n){return t<n[3]-0},gt:function(e,t,n){return t>n[3]-0},nth:function(e,t,n){return n[3]-0===t},eq:function(e,t,n){return n[3]-0===t}},filter:{PSEUDO:function(e,t,n,r){var i=t[1],s=d.filters[i];if(s)return s(e,n,t,r);if(i==="contains")return(e.textContent||e.innerText||p([e])||"").indexOf(t[3])>=0;if(i==="not"){var o=t[3];for(var u=0,a=o.length;u<a;u++)if(o[u]===e)return!1;return!0}h.error(i)},CHILD:function(e,t){var n,i,s,o,u,a,f,l=t[1],c=e;switch(l){case"only":case"first":while(c=c.previousSibling)if(c.nodeType===1)return!1;if(l==="first")return!0;c=e;case"last":while(c=c.nextSibling)if(c.nodeType===1)return!1;return!0;case"nth":n=t[2],i=t[3];if(n===1&&i===0)return!0;s=t[0],o=e.parentNode;if(o&&(o[r]!==s||!e.nodeIndex)){a=0;for(c=o.firstChild;c;c=c.nextSibling)c.nodeType===1&&(c.nodeIndex=++a);o[r]=s}return f=e.nodeIndex-i,n===0?f===0:f%n===0&&f/n>=0}},ID:function(e,t){return e.nodeType===1&&e.getAttribute("id")===t},TAG:function(e,t){return t==="*"&&e.nodeType===1||!!e.nodeName&&e.nodeName.toLowerCase()===t},CLASS:function(e,t){return(" "+(e.className||e.getAttribute("class"))+" ").indexOf(t)>-1},ATTR:function(e,t){var n=t[1],r=h.attr?h.attr(e,n):d.attrHandle[n]?d.attrHandle[n](e):e[n]!=null?e[n]:e.getAttribute(n),i=r+"",s=t[2],o=t[4];return r==null?s==="!=":!s&&h.attr?r!=null:s==="="?i===o:s==="*="?i.indexOf(o)>=0:s==="~="?(" "+i+" ").indexOf(o)>=0:o?s==="!="?i!==o:s==="^="?i.indexOf(o)===0:s==="$="?i.substr(i.length-o.length)===o:s==="|="?i===o||i.substr(0,o.length+1)===o+"-":!1:i&&r!==!1},POS:function(e,t,n,r){var i=t[2],s=d.setFilters[i];if(s)return s(e,n,t,r)}}},v=d.match.POS,m=function(e,t){return"\\"+(t-0+1)};for(var g in d.match)d.match[g]=new RegExp(d.match[g].source+/(?![^\[]*\])(?![^\(]*\))/.source),d.leftMatch[g]=new RegExp(/(^(?:.|\r|\n)*?)/.source+d.match[g].source.replace(/\\(\d+)/g,m));var y=function(e,t){return e=Array.prototype.slice.call(e,0),t?(t.push.apply(t,e),t):e};try{Array.prototype.slice.call(n.documentElement.childNodes,0)[0].nodeType}catch(b){y=function(e,t){var n=0,r=t||[];if(o.call(e)==="[object Array]")Array.prototype.push.apply(r,e);else if(typeof e.length=="number")for(var i=e.length;n<i;n++)r.push(e[n]);else for(;e[n];n++)r.push(e[n]);return r}}var w,E;n.documentElement.compareDocumentPosition?w=function(e,t){return e===t?(u=!0,0):!e.compareDocumentPosition||!t.compareDocumentPosition?e.compareDocumentPosition?-1:1:e.compareDocumentPosition(t)&4?-1:1}:(w=function(e,t){if(e===t)return u=!0,0;if(e.sourceIndex&&t.sourceIndex)return e.sourceIndex-t.sourceIndex;var n,r,i=[],s=[],o=e.parentNode,a=t.parentNode,f=o;if(o===a)return E(e,t);if(!o)return-1;if(!a)return 1;while(f)i.unshift(f),f=f.parentNode;f=a;while(f)s.unshift(f),f=f.parentNode;n=i.length,r=s.length;for(var l=0;l<n&&l<r;l++)if(i[l]!==s[l])return E(i[l],s[l]);return l===n?E(e,s[l],-1):E(i[l],t,1)},E=function(e,t,n){if(e===t)return n;var r=e.nextSibling;while(r){if(r===t)return-1;r=r.nextSibling}return 1}),function(){var e=n.createElement("div"),r="script"+(new Date).getTime(),i=n.documentElement;e.innerHTML="<a name='"+r+"'/>",i.insertBefore(e,i.firstChild),n.getElementById(r)&&(d.find.ID=function(e,n,r){if(typeof n.getElementById!="undefined"&&!r){var i=n.getElementById(e[1]);return i?i.id===e[1]||typeof i.getAttributeNode!="undefined"&&i.getAttributeNode("id").nodeValue===e[1]?[i]:t:[]}},d.filter.ID=function(e,t){var n=typeof e.getAttributeNode!="undefined"&&e.getAttributeNode("id");return e.nodeType===1&&n&&n.nodeValue===t}),i.removeChild(e),i=e=null}(),function(){var e=n.createElement("div");e.appendChild(n.createComment("")),e.getElementsByTagName("*").length>0&&(d.find.TAG=function(e,t){var n=t.getElementsByTagName(e[1]);if(e[1]==="*"){var r=[];for(var i=0;n[i];i++)n[i].nodeType===1&&r.push(n[i]);n=r}return n}),e.innerHTML="<a href='#'></a>",e.firstChild&&typeof e.firstChild.getAttribute!="undefined"&&e.firstChild.getAttribute("href")!=="#"&&(d.attrHandle.href=function(e){return e.getAttribute("href",2)}),e=null}(),n.querySelectorAll&&function(){var e=h,t=n.createElement("div"),r="__sizzle__";t.innerHTML="<p class='TEST'></p>";if(t.querySelectorAll&&t.querySelectorAll(".TEST").length===0)return;h=function(t,i,s,o){i=i||n;if(!o&&!h.isXML(i)){var u=/^(\w+$)|^\.([\w\-]+$)|^#([\w\-]+$)/.exec(t);if(u&&(i.nodeType===1||i.nodeType===9)){if(u[1])return y(i.getElementsByTagName(t),s);if(u[2]&&d.find.CLASS&&i.getElementsByClassName)return y(i.getElementsByClassName(u[2]),s)}if(i.nodeType===9){if(t==="body"&&i.body)return y([i.body],s);if(u&&u[3]){var a=i.getElementById(u[3]);if(!a||!a.parentNode)return y([],s);if(a.id===u[3])return y([a],s)}try{return y(i.querySelectorAll(t),s)}catch(f){}}else if(i.nodeType===1&&i.nodeName.toLowerCase()!=="object"){var l=i,c=i.getAttribute("id"),p=c||r,v=i.parentNode,m=/^\s*[+~]/.test(t);c?p=p.replace(/'/g,"\\$&"):i.setAttribute("id",p),m&&v&&(i=i.parentNode);try{if(!m||v)return y(i.querySelectorAll("[id='"+p+"'] "+t),s)}catch(g){}finally{c||l.removeAttribute("id")}}}return e(t,i,s,o)};for(var i in e)h[i]=e[i];t=null}(),function(){var e=n.documentElement,t=e.matchesSelector||e.mozMatchesSelector||e.webkitMatchesSelector||e.msMatchesSelector;if(t){var r=!t.call(n.createElement("div"),"div"),i=!1;try{t.call(n.documentElement,"[test!='']:sizzle")}catch(s){i=!0}h.matchesSelector=function(e,n){n=n.replace(/\=\s*([^'"\]]*)\s*\]/g,"='$1']");if(!h.isXML(e))try{if(i||!d.match.PSEUDO.test(n)&&!/!=/.test(n)){var s=t.call(e,n);if(s||!r||e.document&&e.document.nodeType!==11)return s}}catch(o){}return h(n,null,null,[e]).length>0}}}(),function(){var e=n.createElement("div");e.innerHTML="<div class='test e'></div><div class='test'></div>";if(!e.getElementsByClassName||e.getElementsByClassName("e").length===0)return;e.lastChild.className="e";if(e.getElementsByClassName("e").length===1)return;d.order.splice(1,0,"CLASS"),d.find.CLASS=function(e,t,n){if(typeof t.getElementsByClassName!="undefined"&&!n)return t.getElementsByClassName(e[1])},e=null}(),n.documentElement.contains?h.contains=function(e,t){return e!==t&&(e.contains?e.contains(t):!0)}:n.documentElement.compareDocumentPosition?h.contains=function(e,t){return!!(e.compareDocumentPosition(t)&16)}:h.contains=function(){return!1},h.isXML=function(e){var t=(e?e.ownerDocument||e:0).documentElement;return t?t.nodeName!=="HTML":!1};var T=function(e,t,n){var r,i=[],s="",o=t.nodeType?[t]:t;while(r=d.match.PSEUDO.exec(e))s+=r[0],e=e.replace(d.match.PSEUDO,"");e=d.relative[e]?e+"*":e;for(var u=0,a=o.length;u<a;u++)h(e,o[u],i,n);return h.filter(s,i)};h.attr=s.attr,h.selectors.attrMap={},s.find=h,s.expr=h.selectors,s.expr[":"]=s.expr.filters,s.unique=h.uniqueSort,s.text=h.getText,s.isXMLDoc=h.isXML,s.contains=h.contains}();var j=/Until$/,F=/^(?:parents|prevUntil|prevAll)/,I=/,/,q=/^.[^:#\[\.,]*$/,R=Array.prototype.slice,U=s.expr.match.POS,z={children:!0,contents:!0,next:!0,prev:!0};s.fn.extend({find:function(e){var t=this,n,r;if(typeof e!="string")return s(e).filter(function(){for(n=0,r=t.length;n<r;n++)if(s.contains(t[n],this))return!0});var i=this.pushStack("","find",e),o,u,a;for(n=0,r=this.length;n<r;n++){o=i.length,s.find(e,this[n],i);if(n>0)for(u=o;u<i.length;u++)for(a=0;a<o;a++)if(i[a]===i[u]){i.splice(u--,1);break}}return i},has:function(e){var t=s(e);return this.filter(function(){for(var e=0,n=t.length;e<n;e++)if(s.contains(this,t[e]))return!0})},not:function(e){return this.pushStack(X(this,e,!1),"not",e)},filter:function(e){return this.pushStack(X(this,e,!0),"filter",e)},is:function(e){return!!e&&(typeof e=="string"?U.test(e)?s(e,this.context).index(this[0])>=0:s.filter(e,this).length>0:this.filter(e).length>0)},closest:function(e,t){var n=[],r,i,o=this[0];if(s.isArray(e)){var u=1;while(o&&o.ownerDocument&&o!==t){for(r=0;r<e.length;r++)s(o).is(e[r])&&n.push({selector:e[r],elem:o,level:u});o=o.parentNode,u++}return n}var a=U.test(e)||typeof e!="string"?s(e,t||this.context):0;for(r=0,i=this.length;r<i;r++){o=this[r];while(o){if(a?a.index(o)>-1:s.find.matchesSelector(o,e)){n.push(o);break}o=o.parentNode;if(!o||!o.ownerDocument||o===t||o.nodeType===11)break}}return n=n.length>1?s.unique(n):n,this.pushStack(n,"closest",e)},index:function(e){return e?typeof e=="string"?s.inArray(this[0],s(e)):s.inArray(e.jquery?e[0]:e,this):this[0]&&this[0].parentNode?this.prevAll().length:-1},add:function(e,t){var n=typeof e=="string"?s(e,t):s.makeArray(e&&e.nodeType?[e]:e),r=s.merge(this.get(),n);return this.pushStack(W(n[0])||W(r[0])?r:s.unique(r))},andSelf:function(){return this.add(this.prevObject)}}),s.each({parent:function(e){var t=e.parentNode;return t&&t.nodeType!==11?t:null},parents:function(e){return s.dir(e,"parentNode")},parentsUntil:function(e,t,n){return s.dir(e,"parentNode",n)},next:function(e){return s.nth(e,2,"nextSibling")},prev:function(e){return s.nth(e,2,"previousSibling")},nextAll:function(e){return s.dir(e,"nextSibling")},prevAll:function(e){return s.dir(e,"previousSibling")},nextUntil:function(e,t,n){return s.dir(e,"nextSibling",n)},prevUntil:function(e,t,n){return s.dir(e,"previousSibling",n)},siblings:function(e){return s.sibling(e.parentNode.firstChild,e)},children:function(e){return s.sibling(e.firstChild)},contents:function(e){return s.nodeName(e,"iframe")?e.contentDocument||e.contentWindow.document:s.makeArray(e.childNodes)}},function(e,t){s.fn[e]=function(n,r){var i=s.map(this,t,n);return j.test(e)||(r=n),r&&typeof r=="string"&&(i=s.filter(r,i)),i=this.length>1&&!z[e]?s.unique(i):i,(this.length>1||I.test(r))&&F.test(e)&&(i=i.reverse()),this.pushStack(i,e,R.call(arguments).join(","))}}),s.extend({filter:function(e,t,n){return n&&(e=":not("+e+")"),t.length===1?s.find.matchesSelector(t[0],e)?[t[0]]:[]:s.find.matches(e,t)},dir:function(e,n,r){var i=[],o=e[n];while(o&&o.nodeType!==9&&(r===t||o.nodeType!==1||!s(o).is(r)))o.nodeType===1&&i.push(o),o=o[n];return i},nth:function(e,t,n,r){t=t||1;var i=0;for(;e;e=e[n])if(e.nodeType===1&&++i===t)break;return e},sibling:function(e,t){var n=[];for(;e;e=e.nextSibling)e.nodeType===1&&e!==t&&n.push(e);return n}});var $="abbr|article|aside|audio|canvas|datalist|details|figcaption|figure|footer|header|hgroup|mark|meter|nav|output|progress|section|summary|time|video",J=/ jQuery\d+="(?:\d+|null)"/g,K=/^\s+/,Q=/<(?!area|br|col|embed|hr|img|input|link|meta|param)(([\w:]+)[^>]*)\/>/ig,G=/<([\w:]+)/,Y=/<tbody/i,Z=/<|&#?\w+;/,et=/<(?:script|style)/i,tt=/<(?:script|object|embed|option|style)/i,nt=new RegExp("<(?:"+$+")","i"),rt=/checked\s*(?:[^=]|=\s*.checked.)/i,it=/\/(java|ecma)script/i,st=/^\s*<!(?:\[CDATA\[|\-\-)/,ot={option:[1,"<select multiple='multiple'>","</select>"],legend:[1,"<fieldset>","</fieldset>"],thead:[1,"<table>","</table>"],tr:[2,"<table><tbody>","</tbody></table>"],td:[3,"<table><tbody><tr>","</tr></tbody></table>"],col:[2,"<table><tbody></tbody><colgroup>","</colgroup></table>"],area:[1,"<map>","</map>"],_default:[0,"",""]},ut=V(n);ot.optgroup=ot.option,ot.tbody=ot.tfoot=ot.colgroup=ot.caption=ot.thead,ot.th=ot.td,s.support.htmlSerialize||(ot._default=[1,"div<div>","</div>"]),s.fn.extend({text:function(e){return s.isFunction(e)?this.each(function(t){var n=s(this);n.text(e.call(this,t,n.text()))}):typeof e!="object"&&e!==t?this.empty().append((this[0]&&this[0].ownerDocument||n).createTextNode(e)):s.text(this)},wrapAll:function(e){if(s.isFunction(e))return this.each(function(t){s(this).wrapAll(e.call(this,t))});if(this[0]){var t=s(e,this[0].ownerDocument).eq(0).clone(!0);this[0].parentNode&&t.insertBefore(this[0]),t.map(function(){var e=this;while(e.firstChild&&e.firstChild.nodeType===1)e=e.firstChild;return e}).append(this)}return this},wrapInner:function(e){return s.isFunction(e)?this.each(function(t){s(this).wrapInner(e.call(this,t))}):this.each(function(){var t=s(this),n=t.contents();n.length?n.wrapAll(e):t.append(e)})},wrap:function(e){var t=s.isFunction(e);return this.each(function(n){s(this).wrapAll(t?e.call(this,n):e)})},unwrap:function(){return this.parent().each(function(){s.nodeName(this,"body")||s(this).replaceWith(this.childNodes)}).end()},append:function(){return this.domManip(arguments,!0,function(e){this.nodeType===1&&this.appendChild(e)})},prepend:function(){return this.domManip(arguments,!0,function(e){this.nodeType===1&&this.insertBefore(e,this.firstChild)})},before:function(){if(this[0]&&this[0].parentNode)return this.domManip(arguments,!1,function(e){this.parentNode.insertBefore(e,this)});if(arguments.length){var e=s.clean(arguments);return e.push.apply(e,this.toArray()),this.pushStack(e,"before",arguments)}},after:function(){if(this[0]&&this[0].parentNode)return this.domManip(arguments,!1,function(e){this.parentNode.insertBefore(e,this.nextSibling)});if(arguments.length){var e=this.pushStack(this,"after",arguments);return e.push.apply(e,s.clean(arguments)),e}},remove:function(e,t){for(var n=0,r;(r=this[n])!=null;n++)if(!e||s.filter(e,[r]).length)!t&&r.nodeType===1&&(s.cleanData(r.getElementsByTagName("*")),s.cleanData([r])),r.parentNode&&r.parentNode.removeChild(r);return this},empty:function(){for(var e=0,t;(t=this[e])!=null;e++){t.nodeType===1&&s.cleanData(t.getElementsByTagName("*"));while(t.firstChild)t.removeChild(t.firstChild)}return this},clone:function(e,t){return e=e==null?!1:e,t=t==null?e:t,this.map(function(){return s.clone(this,e,t)})},html:function(e){if(e===t)return this[0]&&this[0].nodeType===1?this[0].innerHTML.replace(J,""):null;if(typeof e=="string"&&!et.test(e)&&(s.support.leadingWhitespace||!K.test(e))&&!ot[(G.exec(e)||["",""])[1].toLowerCase()]){e=e.replace(Q,"<$1></$2>");try{for(var n=0,r=this.length;n<r;n++)this[n].nodeType===1&&(s.cleanData(this[n].getElementsByTagName("*")),this[n].innerHTML=e)}catch(i){this.empty().append(e)}}else s.isFunction(e)?this.each(function(t){var n=s(this);n.html(e.call(this,t,n.html()))}):this.empty().append(e);return this},replaceWith:function(e){return this[0]&&this[0].parentNode?s.isFunction(e)?this.each(function(t){var n=s(this),r=n.html();n.replaceWith(e.call(this,t,r))}):(typeof e!="string"&&(e=s(e).detach()),this.each(function(){var t=this.nextSibling,n=this.parentNode;s(this).remove(),t?s(t).before(e):s(n).append(e)})):this.length?this.pushStack(s(s.isFunction(e)?e():e),"replaceWith",e):this},detach:function(e){return this.remove(e,!0)},domManip:function(e,n,r){var i,o,u,a,f=e[0],l=[];if(!s.support.checkClone&&arguments.length===3&&typeof f=="string"&&rt.test(f))return this.each(function(){s(this).domManip(e,n,r,!0)});if(s.isFunction(f))return this.each(function(i){var o=s(this);e[0]=f.call(this,i,n?o.html():t),o.domManip(e,n,r)});if(this[0]){a=f&&f.parentNode,s.support.parentNode&&a&&a.nodeType===11&&a.childNodes.length===this.length?i={fragment:a}:i=s.buildFragment(e,this,l),u=i.fragment,u.childNodes.length===1?o=u=u.firstChild:o=u.firstChild;if(o){n=n&&s.nodeName(o,"tr");for(var c=0,h=this.length,p=h-1;c<h;c++)r.call(n?at(this[c],o):this[c],i.cacheable||h>1&&c<p?s.clone(u,!0,!0):u)}l.length&&s.each(l,vt)}return this}}),s.buildFragment=function(e,t,r){var i,o,u,a,f=e[0];return t&&t[0]&&(a=t[0].ownerDocument||t[0]),a.createDocumentFragment||(a=n),e.length===1&&typeof f=="string"&&f.length<512&&a===n&&f.charAt(0)==="<"&&!tt.test(f)&&(s.support.checkClone||!rt.test(f))&&(s.support.html5Clone||!nt.test(f))&&(o=!0,u=s.fragments[f],u&&u!==1&&(i=u)),i||(i=a.createDocumentFragment(),s.clean(e,a,i,r)),o&&(s.fragments[f]=u?i:1),{fragment:i,cacheable:o}},s.fragments={},s.each({appendTo:"append",prependTo:"prepend",insertBefore:"before",insertAfter:"after",replaceAll:"replaceWith"},function(e,t){s.fn[e]=function(n){var r=[],i=s(n),o=this.length===1&&this[0].parentNode;if(o&&o.nodeType===11&&o.childNodes.length===1&&i.length===1)return i[t](this[0]),this;for(var u=0,a=i.length;u<a;u++){var f=(u>0?this.clone(!0):this).get();s(i[u])[t](f),r=r.concat(f)}return this.pushStack(r,e,i.selector)}}),s.extend({clone:function(e,t,n){var r,i,o,u=s.support.html5Clone||!nt.test("<"+e.nodeName)?e.cloneNode(!0):dt(e);if((!s.support.noCloneEvent||!s.support.noCloneChecked)&&(e.nodeType===1||e.nodeType===11)&&!s.isXMLDoc(e)){lt(e,u),r=ct(e),i=ct(u);for(o=0;r[o];++o)i[o]&&lt(r[o],i[o])}if(t){ft(e,u);if(n){r=ct(e),i=ct(u);for(o=0;r[o];++o)ft(r[o],i[o])}}return r=i=null,u},clean:function(e,t,r,i){var o;t=t||n,typeof t.createElement=="undefined"&&(t=t.ownerDocument||t[0]&&t[0].ownerDocument||n);var u=[],a;for(var f=0,l;(l=e[f])!=null;f++){typeof l=="number"&&(l+="");if(!l)continue;if(typeof l=="string")if(!Z.test(l))l=t.createTextNode(l);else{l=l.replace(Q,"<$1></$2>");var c=(G.exec(l)||["",""])[1].toLowerCase(),h=ot[c]||ot._default,p=h[0],d=t.createElement("div");t===n?ut.appendChild(d):V(t).appendChild(d),d.innerHTML=h[1]+l+h[2];while(p--)d=d.lastChild;if(!s.support.tbody){var v=Y.test(l),m=c==="table"&&!v?d.firstChild&&d.firstChild.childNodes:h[1]==="<table>"&&!v?d.childNodes:[];for(a=m.length-1;a>=0;--a)s.nodeName(m[a],"tbody")&&!m[a].childNodes.length&&m[a].parentNode.removeChild(m[a])}!s.support.leadingWhitespace&&K.test(l)&&d.insertBefore(t.createTextNode(K.exec(l)[0]),d.firstChild),l=d.childNodes}var g;if(!s.support.appendChecked)if(l[0]&&typeof (g=l.length)=="number")for(a=0;a<g;a++)pt(l[a]);else pt(l);l.nodeType?u.push(l):u=s.merge(u,l)}if(r){o=function(e){return!e.type||it.test(e.type)};for(f=0;u[f];f++)if(i&&s.nodeName(u[f],"script")&&(!u[f].type||u[f].type.toLowerCase()==="text/javascript"))i.push(u[f].parentNode?u[f].parentNode.removeChild(u[f]):u[f]);else{if(u[f].nodeType===1){var y=s.grep(u[f].getElementsByTagName("script"),o);u.splice.apply(u,[f+1,0].concat(y))}r.appendChild(u[f])}}return u},cleanData:function(e){var t,n,r=s.cache,i=s.event.special,o=s.support.deleteExpando;for(var u=0,a;(a=e[u])!=null;u++){if(a.nodeName&&s.noData[a.nodeName.toLowerCase()])continue;n=a[s.expando];if(n){t=r[n];if(t&&t.events){for(var f in t.events)i[f]?s.event.remove(a,f):s.removeEvent(a,f,t.handle);t.handle&&(t.handle.elem=null)}o?delete a[s.expando]:a.removeAttribute&&a.removeAttribute(s.expando),delete r[n]}}}});var mt=/alpha\([^)]*\)/i,gt=/opacity=([^)]*)/,yt=/([A-Z]|^ms)/g,bt=/^-?\d+(?:px)?$/i,wt=/^-?\d/,Et=/^([\-+])=([\-+.\de]+)/,St={position:"absolute",visibility:"hidden",display:"block"},xt=["Left","Right"],Tt=["Top","Bottom"],Nt,Ct,kt;s.fn.css=function(e,n){return arguments.length===2&&n===t?this:s.access(this,e,n,!0,function(e,n,r){return r!==t?s.style(e,n,r):s.css(e,n)})},s.extend({cssHooks:{opacity:{get:function(e,t){if(t){var n=Nt(e,"opacity","opacity");return n===""?"1":n}return e.style.opacity}}},cssNumber:{fillOpacity:!0,fontWeight:!0,lineHeight:!0,opacity:!0,orphans:!0,widows:!0,zIndex:!0,zoom:!0},cssProps:{"float":s.support.cssFloat?"cssFloat":"styleFloat"},style:function(e,n,r,i){if(!e||e.nodeType===3||e.nodeType===8||!e.style)return;var o,u,a=s.camelCase(n),f=e.style,l=s.cssHooks[a];n=s.cssProps[a]||a;if(r===t)return l&&"get"in l&&(o=l.get(e,!1,i))!==t?o:f[n];u=typeof r,u==="string"&&(o=Et.exec(r))&&(r=+(o[1]+1)*+o[2]+parseFloat(s.css(e,n)),u="number");if(r==null||u==="number"&&isNaN(r))return;u==="number"&&!s.cssNumber[a]&&(r+="px");if(!l||!("set"in l)||(r=l.set(e,r))!==t)try{f[n]=r}catch(c){}},css:function(e,n,r){var i,o;n=s.camelCase(n),o=s.cssHooks[n],n=s.cssProps[n]||n,n==="cssFloat"&&(n="float");if(o&&"get"in o&&(i=o.get(e,!0,r))!==t)return i;if(Nt)return Nt(e,n)},swap:function(e,t,n){var r={};for(var i in t)r[i]=e.style[i],e.style[i]=t[i];n.call(e);for(i in t)e.style[i]=r[i]}}),s.curCSS=s.css,s.each(["height","width"],function(e,t){s.cssHooks[t]={get:function(e,n,r){var i;if(n)return e.offsetWidth!==0?Lt(e,t,r):(s.swap(e,St,function(){i=Lt(e,t,r)}),i)},set:function(e,t){if(!bt.test(t))return t;t=parseFloat(t);if(t>=0)return t+"px"}}}),s.support.opacity||(s.cssHooks.opacity={get:function(e,t){return gt.test((t&&e.currentStyle?e.currentStyle.filter:e.style.filter)||"")?parseFloat(RegExp.$1)/100+"":t?"1":""},set:function(e,t){var n=e.style,r=e.currentStyle,i=s.isNumeric(t)?"alpha(opacity="+t*100+")":"",o=r&&r.filter||n.filter||"";n.zoom=1;if(t>=1&&s.trim(o.replace(mt,""))===""){n.removeAttribute("filter");if(r&&!r.filter)return}n.filter=mt.test(o)?o.replace(mt,i):o+" "+i}}),s(function(){s.support.reliableMarginRight||(s.cssHooks.marginRight={get:function(e,t){var n;return s.swap(e,{display:"inline-block"},function(){t?n=Nt(e,"margin-right","marginRight"):n=e.style.marginRight}),n}})}),n.defaultView&&n.defaultView.getComputedStyle&&(Ct=function(e,t){var n,r,i;return t=t.replace(yt,"-$1").toLowerCase(),(r=e.ownerDocument.defaultView)&&(i=r.getComputedStyle(e,null))&&(n=i.getPropertyValue(t),n===""&&!s.contains(e.ownerDocument.documentElement,e)&&(n=s.style(e,t))),n}),n.documentElement.currentStyle&&(kt=function(e,t){var n,r,i,s=e.currentStyle&&e.currentStyle[t],o=e.style;return s===null&&o&&(i=o[t])&&(s=i),!bt.test(s)&&wt.test(s)&&(n=o.left,r=e.runtimeStyle&&e.runtimeStyle.left,r&&(e.runtimeStyle.left=e.currentStyle.left),o.left=t==="fontSize"?"1em":s||0,s=o.pixelLeft+"px",o.left=n,r&&(e.runtimeStyle.left=r)),s===""?"auto":s}),Nt=Ct||kt,s.expr&&s.expr.filters&&(s.expr.filters.hidden=function(e){var t=e.offsetWidth,n=e.offsetHeight;return t===0&&n===0||!s.support.reliableHiddenOffsets&&(e.style&&e.style.display||s.css(e,"display"))==="none"},s.expr.filters.visible=function(e){return!s.expr.filters.hidden(e)});var At=/%20/g,Ot=/\[\]$/,Mt=/\r?\n/g,_t=/#.*$/,Dt=/^(.*?):[ \t]*([^\r\n]*)\r?$/mg,Pt=/^(?:color|date|datetime|datetime-local|email|hidden|month|number|password|range|search|tel|text|time|url|week)$/i,Ht=/^(?:about|app|app\-storage|.+\-extension|file|res|widget):$/,Bt=/^(?:GET|HEAD)$/,jt=/^\/\//,Ft=/\?/,It=/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,qt=/^(?:select|textarea)/i,Rt=/\s+/,Ut=/([?&])_=[^&]*/,zt=/^([\w\+\.\-]+:)(?:\/\/([^\/?#:]*)(?::(\d+))?)?/,Wt=s.fn.load,Xt={},Vt={},$t,Jt,Kt=["*/"]+["*"];try{$t=i.href}catch(Qt){$t=n.createElement("a"),$t.href="",$t=$t.href}Jt=zt.exec($t.toLowerCase())||[],s.fn.extend({load:function(e,n,r){if(typeof e!="string"&&Wt)return Wt.apply(this,arguments);if(!this.length)return this;var i=e.indexOf(" ");if(i>=0){var o=e.slice(i,e.length);e=e.slice(0,i)}var u="GET";n&&(s.isFunction(n)?(r=n,n=t):typeof n=="object"&&(n=s.param(n,s.ajaxSettings.traditional),u="POST"));var a=this;return s.ajax({url:e,type:u,dataType:"html",data:n,complete:function(e,t,n){n=e.responseText,e.isResolved()&&(e.done(function(e){n=e}),a.html(o?s("<div>").append(n.replace(It,"")).find(o):n)),r&&a.each(r,[n,t,e])}}),this},serialize:function(){return s.param(this.serializeArray())},serializeArray:function(){return this.map(function(){return this.elements?s.makeArray(this.elements):this}).filter(function(){return this.name&&!this.disabled&&(this.checked||qt.test(this.nodeName)||Pt.test(this.type))}).map(function(e,t){var n=s(this).val();return n==null?null:s.isArray(n)?s.map(n,function(e,n){return{name:t.name,value:e.replace(Mt,"\r\n")}}):{name:t.name,value:n.replace(Mt,"\r\n")}}).get()}}),s.each("ajaxStart ajaxStop ajaxComplete ajaxError ajaxSuccess ajaxSend".split(" "),function(e,t){s.fn[t]=function(e){return this.on(t,e)}}),s.each(["get","post"],function(e,n){s[n]=function(e,r,i,o){return s.isFunction(r)&&(o=o||i,i=r,r=t),s.ajax({type:n,url:e,data:r,success:i,dataType:o})}}),s.extend({getScript:function(e,n){return s.get(e,t,n,"script")},getJSON:function(e,t,n){return s.get(e,t,n,"json")},ajaxSetup:function(e,t){return t?Zt(e,s.ajaxSettings):(t=e,e=s.ajaxSettings),Zt(e,t),e},ajaxSettings:{url:$t,isLocal:Ht.test(Jt[1]),global:!0,type:"GET",contentType:"application/x-www-form-urlencoded",processData:!0,async:!0,accepts:{xml:"application/xml, text/xml",html:"text/html",text:"text/plain",json:"application/json, text/javascript","*":Kt},contents:{xml:/xml/,html:/html/,json:/json/},responseFields:{xml:"responseXML",text:"responseText"},converters:{"* text":e.String,"text html":!0,"text json":s.parseJSON,"text xml":s.parseXML},flatOptions:{context:!0,url:!0}},ajaxPrefilter:Gt(Xt),ajaxTransport:Gt(Vt),ajax:function(e,n){function S(e,n,c,h){if(y===2)return;y=2,m&&clearTimeout(m),v=t,p=h||"",E.readyState=e>0?4:0;var d,g,w,S=n,x=c?tn(r,E,c):t,T,N;if(e>=200&&e<300||e===304){if(r.ifModified){if(T=E.getResponseHeader("Last-Modified"))s.lastModified[l]=T;if(N=E.getResponseHeader("Etag"))s.etag[l]=N}if(e===304)S="notmodified",d=!0;else try{g=nn(r,x),S="success",d=!0}catch(C){S="parsererror",w=C}}else{w=S;if(!S||e)S="error",e<0&&(e=0)}E.status=e,E.statusText=""+(n||S),d?u.resolveWith(i,[g,S,E]):u.rejectWith(i,[E,S,w]),E.statusCode(f),f=t,b&&o.trigger("ajax"+(d?"Success":"Error"),[E,r,d?g:w]),a.fireWith(i,[E,S]),b&&(o.trigger("ajaxComplete",[E,r]),--s.active||s.event.trigger("ajaxStop"))}typeof e=="object"&&(n=e,e=t),n=n||{};var r=s.ajaxSetup({},n),i=r.context||r,o=i!==r&&(i.nodeType||i instanceof s)?s(i):s.event,u=s.Deferred(),a=s.Callbacks("once memory"),f=r.statusCode||{},l,c={},h={},p,d,v,m,g,y=0,b,w,E={readyState:0,setRequestHeader:function(e,t){if(!y){var n=e.toLowerCase();e=h[n]=h[n]||e,c[e]=t}return this},getAllResponseHeaders:function(){return y===2?p:null},getResponseHeader:function(e){var n;if(y===2){if(!d){d={};while(n=Dt.exec(p))d[n[1].toLowerCase()]=n[2]}n=d[e.toLowerCase()]}return n===t?null:n},overrideMimeType:function(e){return y||(r.mimeType=e),this},abort:function(e){return e=e||"abort",v&&v.abort(e),S(0,e),this}};u.promise(E),E.success=E.done,E.error=E.fail,E.complete=a.add,E.statusCode=function(e){if(e){var t;if(y<2)for(t in e)f[t]=[f[t],e[t]];else t=e[E.status],E.then(t,t)}return this},r.url=((e||r.url)+"").replace(_t,"").replace(jt,Jt[1]+"//"),r.dataTypes=s.trim(r.dataType||"*").toLowerCase().split(Rt),r.crossDomain==null&&(g=zt.exec(r.url.toLowerCase()),r.crossDomain=!(!g||g[1]==Jt[1]&&g[2]==Jt[2]&&(g[3]||(g[1]==="http:"?80:443))==(Jt[3]||(Jt[1]==="http:"?80:443)))),r.data&&r.processData&&typeof r.data!="string"&&(r.data=s.param(r.data,r.traditional)),Yt(Xt,r,n,E);if(y===2)return!1;b=r.global,r.type=r.type.toUpperCase(),r.hasContent=!Bt.test(r.type),b&&s.active++===0&&s.event.trigger("ajaxStart");if(!r.hasContent){r.data&&(r.url+=(Ft.test(r.url)?"&":"?")+r.data,delete r.data),l=r.url;if(r.cache===!1){var x=s.now(),T=r.url.replace(Ut,"$1_="+x);r.url=T+(T===r.url?(Ft.test(r.url)?"&":"?")+"_="+x:"")}}(r.data&&r.hasContent&&r.contentType!==!1||n.contentType)&&E.setRequestHeader("Content-Type",r.contentType),r.ifModified&&(l=l||r.url,s.lastModified[l]&&E.setRequestHeader("If-Modified-Since",s.lastModified[l]),s.etag[l]&&E.setRequestHeader("If-None-Match",s.etag[l])),E.setRequestHeader("Accept",r.dataTypes[0]&&r.accepts[r.dataTypes[0]]?r.accepts[r.dataTypes[0]]+(r.dataTypes[0]!=="*"?", "+Kt+"; q=0.01":""):r.accepts["*"]);for(w in r.headers)E.setRequestHeader(w,r.headers[w]);if(!r.beforeSend||r.beforeSend.call(i,E,r)!==!1&&y!==2){for(w in{success:1,error:1,complete:1})E[w](r[w]);v=Yt(Vt,r,n,E);if(!v)S(-1,"No Transport");else{E.readyState=1,b&&o.trigger("ajaxSend",[E,r]),r.async&&r.timeout>0&&(m=setTimeout(function(){E.abort("timeout")},r.timeout));try{y=1,v.send(c,S)}catch(N){if(!(y<2))throw N;S(-1,N)}}return E}return E.abort(),!1},param:function(e,n){var r=[],i=function(e,t){t=s.isFunction(t)?t():t,r[r.length]=encodeURIComponent(e)+"="+encodeURIComponent(t)};n===t&&(n=s.ajaxSettings.traditional);if(s.isArray(e)||e.jquery&&!s.isPlainObject(e))s.each(e,function(){i(this.name,this.value)});else for(var o in e)en(o,e[o],n,i);return r.join("&").replace(At,"+")}}),s.extend({active:0,lastModified:{},etag:{}});var rn=s.now(),sn=/(\=)\?(&|$)|\?\?/i;s.ajaxSetup({jsonp:"callback",jsonpCallback:function(){return s.expando+"_"+rn++}}),s.ajaxPrefilter("json jsonp",function(t,n,r){var i=t.contentType==="application/x-www-form-urlencoded"&&typeof t.data=="string";if(t.dataTypes[0]==="jsonp"||t.jsonp!==!1&&(sn.test(t.url)||i&&sn.test(t.data))){var o,u=t.jsonpCallback=s.isFunction(t.jsonpCallback)?t.jsonpCallback():t.jsonpCallback,a=e[u],f=t.url,l=t.data,c="$1"+u+"$2";return t.jsonp!==!1&&(f=f.replace(sn,c),t.url===f&&(i&&(l=l.replace(sn,c)),t.data===l&&(f+=(/\?/.test(f)?"&":"?")+t.jsonp+"="+u))),t.url=f,t.data=l,e[u]=function(e){o=[e]},r.always(function(){e[u]=a,o&&s.isFunction(a)&&e[u](o[0])}),t.converters["script json"]=function(){return o||s.error(u+" was not called"),o[0]},t.dataTypes[0]="json","script"}}),s.ajaxSetup({accepts:{script:"text/javascript, application/javascript, application/ecmascript, application/x-ecmascript"},contents:{script:/javascript|ecmascript/},converters:{"text script":function(e){return s.globalEval(e),e}}}),s.ajaxPrefilter("script",function(e){e.cache===t&&(e.cache=!1),e.crossDomain&&(e.type="GET",e.global=!1)}),s.ajaxTransport("script",function(e){if(e.crossDomain){var r,i=n.head||n.getElementsByTagName("head")[0]||n.documentElement;return{send:function(s,o){r=n.createElement("script"),r.async="async",e.scriptCharset&&(r.charset=e.scriptCharset),r.src=e.url,r.onload=r.onreadystatechange=function(e,n){if(n||!r.readyState||/loaded|complete/.test(r.readyState))r.onload=r.onreadystatechange=null,i&&r.parentNode&&i.removeChild(r),r=t,n||o(200,"success")},i.insertBefore(r,i.firstChild)},abort:function(){r&&r.onload(0,1)}}}});var on=e.ActiveXObject?function(){for(var e in an)an[e](0,1)}:!1,un=0,an;s.ajaxSettings.xhr=e.ActiveXObject?function(){return!this.isLocal&&fn()||ln()}:fn,function(e){s.extend(s.support,{ajax:!!e,cors:!!e&&"withCredentials"in e})}(s.ajaxSettings.xhr()),s.support.ajax&&s.ajaxTransport(function(n){if(!n.crossDomain||s.support.cors){var r;return{send:function(i,o){var u=n.xhr(),a,f;n.username?u.open(n.type,n.url,n.async,n.username,n.password):u.open(n.type,n.url,n.async);if(n.xhrFields)for(f in n.xhrFields)u[f]=n.xhrFields[f];n.mimeType&&u.overrideMimeType&&u.overrideMimeType(n.mimeType),!n.crossDomain&&!i["X-Requested-With"]&&(i["X-Requested-With"]="XMLHttpRequest");try{for(f in i)u.setRequestHeader(f,i[f])}catch(l){}u.send(n.hasContent&&n.data||null),r=function(e,i){var f,l,c,h,p;try{if(r&&(i||u.readyState===4)){r=t,a&&(u.onreadystatechange=s.noop,on&&delete an[a]);if(i)u.readyState!==4&&u.abort();else{f=u.status,c=u.getAllResponseHeaders(),h={},p=u.responseXML,p&&p.documentElement&&(h.xml=p),h.text=u.responseText;try{l=u.statusText}catch(d){l=""}!f&&n.isLocal&&!n.crossDomain?f=h.text?200:404:f===1223&&(f=204)}}}catch(v){i||o(-1,v)}h&&o(f,l,h,c)},!n.async||u.readyState===4?r():(a=++un,on&&(an||(an={},s(e).unload(on)),an[a]=r),u.onreadystatechange=r)},abort:function(){r&&r(0,1)}}}});var cn={},hn,pn,dn=/^(?:toggle|show|hide)$/,vn=/^([+\-]=)?([\d+.\-]+)([a-z%]*)$/i,mn,gn=[["height","marginTop","marginBottom","paddingTop","paddingBottom"],["width","marginLeft","marginRight","paddingLeft","paddingRight"],["opacity"]],yn;s.fn.extend({show:function(e,t,n){var r,i;if(e||e===0)return this.animate(En("show",3),e,t,n);for(var o=0,u=this.length;o<u;o++)r=this[o],r.style&&(i=r.style.display,!s._data(r,"olddisplay")&&i==="none"&&(i=r.style.display=""),i===""&&s.css(r,"display")==="none"&&s._data(r,"olddisplay",Sn(r.nodeName)));for(o=0;o<u;o++){r=this[o];if(r.style){i=r.style.display;if(i===""||i==="none")r.style.display=s._data(r,"olddisplay")||""}}return this},hide:function(e,t,n){if(e||e===0)return this.animate(En("hide",3),e,t,n);var r,i,o=0,u=this.length;for(;o<u;o++)r=this[o],r.style&&(i=s.css(r,"display"),i!=="none"&&!s._data(r,"olddisplay")&&s._data(r,"olddisplay",i));for(o=0;o<u;o++)this[o].style&&(this[o].style.display="none");return this},_toggle:s.fn.toggle,toggle:function(e,t,n){var r=typeof e=="boolean";return s.isFunction(e)&&s.isFunction(t)?this._toggle.apply(this,arguments):e==null||r?this.each(function(){var t=r?e:s(this).is(":hidden");s(this)[t?"show":"hide"]()}):this.animate(En("toggle",3),e,t,n),this},fadeTo:function(e,t,n,r){return this.filter(":hidden").css("opacity",0).show().end().animate({opacity:t},e,n,r)},animate:function(e,t,n,r){function o(){i.queue===!1&&s._mark(this);var t=s.extend({},i),n=this.nodeType===1,r=n&&s(this).is(":hidden"),o,u,a,f,l,c,h,p,d;t.animatedProperties={};for(a in e){o=s.camelCase(a),a!==o&&(e[o]=e[a],delete e[a]),u=e[o],s.isArray(u)?(t.animatedProperties[o]=u[1],u=e[o]=u[0]):t.animatedProperties[o]=t.specialEasing&&t.specialEasing[o]||t.easing||"swing";if(u==="hide"&&r||u==="show"&&!r)return t.complete.call(this);n&&(o==="height"||o==="width")&&(t.overflow=[this.style.overflow,this.style.overflowX,this.style.overflowY],s.css(this,"display")==="inline"&&s.css(this,"float")==="none"&&(!s.support.inlineBlockNeedsLayout||Sn(this.nodeName)==="inline"?this.style.display="inline-block":this.style.zoom=1))}t.overflow!=null&&(this.style.overflow="hidden");for(a in e)f=new s.fx(this,t,a),u=e[a],dn.test(u)?(d=s._data(this,"toggle"+a)||(u==="toggle"?r?"show":"hide":0),d?(s._data(this,"toggle"+a,d==="show"?"hide":"show"),f[d]()):f[u]()):(l=vn.exec(u),c=f.cur(),l?(h=parseFloat(l[2]),p=l[3]||(s.cssNumber[a]?"":"px"),p!=="px"&&(s.style(this,a,(h||1)+p),c=(h||1)/f.cur()*c,s.style(this,a,c+p)),l[1]&&(h=(l[1]==="-="?-1:1)*h+c),f.custom(c,h,p)):f.custom(c,u,""));return!0}var i=s.speed(t,n,r);return s.isEmptyObject(e)?this.each(i.complete,[!1]):(e=s.extend({},e),i.queue===!1?this.each(o):this.queue(i.queue,o))},stop:function(e,n,r){return typeof e!="string"&&(r=n,n=e,e=t),n&&e!==!1&&this.queue(e||"fx",[]),this.each(function(){function u(e,t,n){var i=t[n];s.removeData(e,n,!0),i.stop(r)}var t,n=!1,i=s.timers,o=s._data(this);r||s._unmark(!0,this);if(e==null)for(t in o)o[t]&&o[t].stop&&t.indexOf(".run")===t.length-4&&u(this,o,t);else o[t=e+".run"]&&o[t].stop&&u(this,o,t);for(t=i.length;t--;)i[t].elem===this&&(e==null||i[t].queue===e)&&(r?i[t](!0):i[t].saveState(),n=!0,i.splice(t,1));(!r||!n)&&s.dequeue(this,e)})}}),s.each({slideDown:En("show",1),slideUp:En("hide",1),slideToggle:En("toggle",1),fadeIn:{opacity:"show"},fadeOut:{opacity:"hide"},fadeToggle:{opacity:"toggle"}},function(e,t){s.fn[e]=function(e,n,r){return this.animate(t,e,n,r)}}),s.extend({speed:function(e,t,n){var r=e&&typeof e=="object"?s.extend({},e):{complete:n||!n&&t||s.isFunction(e)&&e,duration:e,easing:n&&t||t&&!s.isFunction(t)&&t};r.duration=s.fx.off?0:typeof r.duration=="number"?r.duration:r.duration in s.fx.speeds?s.fx.speeds[r.duration]:s.fx.speeds._default;if(r.queue==null||r.queue===!0)r.queue="fx";return r.old=r.complete,r.complete=function(e){s.isFunction(r.old)&&r.old.call(this),r.queue?s.dequeue(this,r.queue):e!==!1&&s._unmark(this)},r},easing:{linear:function(e,t,n,r){return n+r*e},swing:function(e,t,n,r){return(-Math.cos(e*Math.PI)/2+.5)*r+n}},timers:[],fx:function(e,t,n){this.options=t,this.elem=e,this.prop=n,t.orig=t.orig||{}}}),s.fx.prototype={update:function(){this.options.step&&this.options.step.call(this.elem,this.now,this),(s.fx.step[this.prop]||s.fx.step._default)(this)},cur:function(){if(this.elem[this.prop]==null||!!this.elem.style&&this.elem.style[this.prop]!=null){var e,t=s.css(this.elem,this.prop);return isNaN(e=parseFloat(t))?!t||t==="auto"?0:t:e}return this.elem[this.prop]},custom:function(e,n,r){function u(e){return i.step(e)}var i=this,o=s.fx;this.startTime=yn||bn(),this.end=n,this.now=this.start=e,this.pos=this.state=0,this.unit=r||this.unit||(s.cssNumber[this.prop]?"":"px"),u.queue=this.options.queue,u.elem=this.elem,u.saveState=function(){i.options.hide&&s._data(i.elem,"fxshow"+i.prop)===t&&s._data(i.elem,"fxshow"+i.prop,i.start)},u()&&s.timers.push(u)&&!mn&&(mn=setInterval(o.tick,o.interval))},show:function(){var e=s._data(this.elem,"fxshow"+this.prop);this.options.orig[this.prop]=e||s.style(this.elem,this.prop),this.options.show=!0,e!==t?this.custom(this.cur(),e):this.custom(this.prop==="width"||this.prop==="height"?1:0,this.cur()),s(this.elem).show()},hide:function(){this.options.orig[this.prop]=s._data(this.elem,"fxshow"+this.prop)||s.style(this.elem,this.prop),this.options.hide=!0,this.custom(this.cur(),0)},step:function(e){var t,n,r,i=yn||bn(),o=!0,u=this.elem,a=this.options;if(e||i>=a.duration+this.startTime){this.now=this.end,this.pos=this.state=1,this.update(),a.animatedProperties[this.prop]=!0;for(t in a.animatedProperties)a.animatedProperties[t]!==!0&&(o=!1);if(o){a.overflow!=null&&!s.support.shrinkWrapBlocks&&s.each(["","X","Y"],function(e,t){u.style["overflow"+t]=a.overflow[e]}),a.hide&&s(u).hide();if(a.hide||a.show)for(t in a.animatedProperties)s.style(u,t,a.orig[t]),s.removeData(u,"fxshow"+t,!0),s.removeData(u,"toggle"+t,!0);r=a.complete,r&&(a.complete=!1,r.call(u))}return!1}return a.duration==Infinity?this.now=i:(n=i-this.startTime,this.state=n/a.duration,this.pos=s.easing[a.animatedProperties[this.prop]](this.state,n,0,1,a.duration),this.now=this.start+(this.end-this.start)*this.pos),this.update(),!0}},s.extend(s.fx,{tick:function(){var e,t=s.timers,n=0;for(;n<t.length;n++)e=t[n],!e()&&t[n]===e&&t.splice(n--,1);t.length||s.fx.stop()},interval:13,stop:function(){clearInterval(mn),mn=null},speeds:{slow:600,fast:200,_default:400},step:{opacity:function(e){s.style(e.elem,"opacity",e.now)},_default:function(e){e.elem.style&&e.elem.style[e.prop]!=null?e.elem.style[e.prop]=e.now+e.unit:e.elem[e.prop]=e.now}}}),s.each(["width","height"],function(e,t){s.fx.step[t]=function(e){s.style(e.elem,t,Math.max(0,e.now)+e.unit)}}),s.expr&&s.expr.filters&&(s.expr.filters.animated=function(e){return s.grep(s.timers,function(t){return e===t.elem}).length});var xn=/^t(?:able|d|h)$/i,Tn=/^(?:body|html)$/i;"getBoundingClientRect"in n.documentElement?s.fn.offset=function(e){var t=this[0],n;if(e)return this.each(function(t){s.offset.setOffset(this,e,t)});if(!t||!t.ownerDocument)return null;if(t===t.ownerDocument.body)return s.offset.bodyOffset(t);try{n=t.getBoundingClientRect()}catch(r){}var i=t.ownerDocument,o=i.documentElement;if(!n||!s.contains(o,t))return n?{top:n.top,left:n.left}:{top:0,left:0};var u=i.body,a=Nn(i),f=o.clientTop||u.clientTop||0,l=o.clientLeft||u.clientLeft||0,c=a.pageYOffset||s.support.boxModel&&o.scrollTop||u.scrollTop,h=a.pageXOffset||s.support.boxModel&&o.scrollLeft||u.scrollLeft,p=n.top+c-f,d=n.left+h-l;return{top:p,left:d}}:s.fn.offset=function(e){var t=this[0];if(e)return this.each(function(t){s.offset.setOffset(this,e,t)});if(!t||!t.ownerDocument)return null;if(t===t.ownerDocument.body)return s.offset.bodyOffset(t);var n,r=t.offsetParent,i=t,o=t.ownerDocument,u=o.documentElement,a=o.body,f=o.defaultView,l=f?f.getComputedStyle(t,null):t.currentStyle,c=t.offsetTop,h=t.offsetLeft;while((t=t.parentNode)&&t!==a&&t!==u){if(s.support.fixedPosition&&l.position==="fixed")break;n=f?f.getComputedStyle(t,null):t.currentStyle,c-=t.scrollTop,h-=t.scrollLeft,t===r&&(c+=t.offsetTop,h+=t.offsetLeft,s.support.doesNotAddBorder&&(!s.support.doesAddBorderForTableAndCells||!xn.test(t.nodeName))&&(c+=parseFloat(n.borderTopWidth)||0,h+=parseFloat(n.borderLeftWidth)||0),i=r,r=t.offsetParent),s.support.subtractsBorderForOverflowNotVisible&&n.overflow!=="visible"&&(c+=parseFloat(n.borderTopWidth)||0,h+=parseFloat(n.borderLeftWidth)||0),l=n}if(l.position==="relative"||l.position==="static")c+=a.offsetTop,h+=a.offsetLeft;return s.support.fixedPosition&&l.position==="fixed"&&(c+=Math.max(u.scrollTop,a.scrollTop),h+=Math.max(u.scrollLeft,a.scrollLeft)),{top:c,left:h}},s.offset={bodyOffset:function(e){var t=e.offsetTop,n=e.offsetLeft;return s.support.doesNotIncludeMarginInBodyOffset&&(t+=parseFloat(s.css(e,"marginTop"))||0,n+=parseFloat(s.css(e,"marginLeft"))||0),{top:t,left:n}},setOffset:function(e,t,n){var r=s.css(e,"position");r==="static"&&(e.style.position="relative");var i=s(e),o=i.offset(),u=s.css(e,"top"),a=s.css(e,"left"),f=(r==="absolute"||r==="fixed")&&s.inArray("auto",[u,a])>-1,l={},c={},h,p;f?(c=i.position(),h=c.top,p=c.left):(h=parseFloat(u)||0,p=parseFloat(a)||0),s.isFunction(t)&&(t=t.call(e,n,o)),t.top!=null&&(l.top=t.top-o.top+h),t.left!=null&&(l.left=t.left-o.left+p),"using"in t?t.using.call(e,l):i.css(l)}},s.fn.extend({position:function(){if(!this[0])return null;var e=this[0],t=this.offsetParent(),n=this.offset(),r=Tn.test(t[0].nodeName)?{top:0,left:0}:t.offset();return n.top-=parseFloat(s.css(e,"marginTop"))||0,n.left-=parseFloat(s.css(e,"marginLeft"))||0,r.top+=parseFloat(s.css(t[0],"borderTopWidth"))||0,r.left+=parseFloat(s.css(t[0],"borderLeftWidth"))||0,{top:n.top-r.top,left:n.left-r.left}},offsetParent:function(){return this.map(function(){var e=this.offsetParent||n.body;while(e&&!Tn.test(e.nodeName)&&s.css(e,"position")==="static")e=e.offsetParent;return e})}}),s.each(["Left","Top"],function(e,n){var r="scroll"+n;s.fn[r]=function(n){var i,o;return n===t?(i=this[0],i?(o=Nn(i),o?"pageXOffset"in o?o[e?"pageYOffset":"pageXOffset"]:s.support.boxModel&&o.document.documentElement[r]||o.document.body[r]:i[r]):null):this.each(function(){o=Nn(this),o?o.scrollTo(e?s(o).scrollLeft():n,e?n:s(o).scrollTop()):this[r]=n})}}),s.each(["Height","Width"],function(e,n){var r=n.toLowerCase();s.fn["inner"+n]=function(){var e=this[0];return e?e.style?parseFloat(s.css(e,r,"padding")):this[r]():null},s.fn["outer"+n]=function(e){var t=this[0];return t?t.style?parseFloat(s.css(t,r,e?"margin":"border")):this[r]():null},s.fn[r]=function(e){var i=this[0];if(!i)return e==null?null:this;if(s.isFunction(e))return this.each(function(t){var n=s(this);n[r](e.call(this,t,n[r]()))});if(s.isWindow(i)){var o=i.document.documentElement["client"+n],u=i.document.body;return i.document.compatMode==="CSS1Compat"&&o||u&&u["client"+n]||o}if(i.nodeType===9)return Math.max(i.documentElement["client"+n],i.body["scroll"+n],i.documentElement["scroll"+n],i.body["offset"+n],i.documentElement["offset"+n]);if(e===t){var a=s.css(i,r),f=parseFloat(a);return s.isNumeric(f)?f:a}return this.css(r,typeof e=="string"?e:e+"px")}}),e.jQuery=e.$=s,typeof define=="function"&&define.amd&&define.amd.jQuery&&define("jquery",[],function(){return s})})(window),function(){var e={};define("use",{version:"0.2.0",load:function(t,n,r,i){var s=i.use&&i.use[t];if(!s)return r();e[t]={deps:s.deps||[],attach:s.attach},n(s.deps||[],function(){n([t],function(){return attach=s.attach,i.isBuild?r():typeof attach=="function"?r(attach.apply(window,arguments)):r(window[attach])})})},write:function(t,n,r){var i=e[n],s={attach:null,deps:""};typeof attach=="function"?s.attach="return "+i.attach.toString()+";":s.attach="return window['"+i.attach+"'];",i.deps.length&&(s.deps="'"+i.deps.toString().split(",").join("','")+"'"),r(["define('",t,"!",n,"', ","[",s.deps,"],","function() {",s.attach,"}",");\n"].join(""))}})}(),function(){function C(e,t,n){if(e===t)return e!==0||1/e==1/t;if(e==null||t==null)return e===t;e._chain&&(e=e._wrapped),t._chain&&(t=t._wrapped);if(e.isEqual&&S.isFunction(e.isEqual))return e.isEqual(t);if(t.isEqual&&S.isFunction(t.isEqual))return t.isEqual(e);var r=a.call(e);if(r!=a.call(t))return!1;switch(r){case"[object String]":return e==String(t);case"[object Number]":return e!=+e?t!=+t:e==0?1/e==1/t:e==+t;case"[object Date]":case"[object Boolean]":return+e==+t;case"[object RegExp]":return e.source==t.source&&e.global==t.global&&e.multiline==t.multiline&&e.ignoreCase==t.ignoreCase}if(typeof e!="object"||typeof t!="object")return!1;var i=n.length;while(i--)if(n[i]==e)return!0;n.push(e);var s=0,o=!0;if(r=="[object Array]"){s=e.length,o=s==t.length;if(o)while(s--)if(!(o=s in e==s in t&&C(e[s],t[s],n)))break}else{if("constructor"in e!="constructor"in t||e.constructor!=t.constructor)return!1;for(var u in e)if(S.has(e,u)){s++;if(!(o=S.has(t,u)&&C(e[u],t[u],n)))break}if(o){for(u in t)if(S.has(t,u)&&!(s--))break;o=!s}}return n.pop(),o}var e=this,t=e._,n={},r=Array.prototype,i=Object.prototype,s=Function.prototype,o=r.slice,u=r.unshift,a=i.toString,f=i.hasOwnProperty,l=r.forEach,c=r.map,h=r.reduce,p=r.reduceRight,d=r.filter,v=r.every,m=r.some,g=r.indexOf,y=r.lastIndexOf,b=Array.isArray,w=Object.keys,E=s.bind,S=function(e){return new O(e)};typeof exports!="undefined"?(typeof module!="undefined"&&module.exports&&(exports=module.exports=S),exports._=S):e._=S,S.VERSION="1.3.1";var x=S.each=S.forEach=function(e,t,r){if(e==null)return;if(l&&e.forEach===l)e.forEach(t,r);else if(e.length===+e.length){for(var i=0,s=e.length;i<s;i++)if(i in e&&t.call(r,e[i],i,e)===n)return}else for(var o in e)if(S.has(e,o)&&t.call(r,e[o],o,e)===n)return};S.map=S.collect=function(e,t,n){var r=[];return e==null?r:c&&e.map===c?e.map(t,n):(x(e,function(e,i,s){r[r.length]=t.call(n,e,i,s)}),e.length===+e.length&&(r.length=e.length),r)},S.reduce=S.foldl=S.inject=function(e,t,n,r){var i=arguments.length>2;e==null&&(e=[]);if(h&&e.reduce===h)return r&&(t=S.bind(t,r)),i?e.reduce(t,n):e.reduce(t);x(e,function(e,s,o){i?n=t.call(r,n,e,s,o):(n=e,i=!0)});if(!i)throw new TypeError("Reduce of empty array with no initial value");return n},S.reduceRight=S.foldr=function(e,t,n,r){var i=arguments.length>2;e==null&&(e=[]);if(p&&e.reduceRight===p)return r&&(t=S.bind(t,r)),i?e.reduceRight(t,n):e.reduceRight(t);var s=S.toArray(e).reverse();return r&&!i&&(t=S.bind(t,r)),i?S.reduce(s,t,n,r):S.reduce(s,t)},S.find=S.detect=function(e,t,n){var r;return T(e,function(e,i,s){if(t.call(n,e,i,s))return r=e,!0}),r},S.filter=S.select=function(e,t,n){var r=[];return e==null?r:d&&e.filter===d?e.filter(t,n):(x(e,function(e,i,s){t.call(n,e,i,s)&&(r[r.length]=e)}),r)},S.reject=function(e,t,n){var r=[];return e==null?r:(x(e,function(e,i,s){t.call(n,e,i,s)||(r[r.length]=e)}),r)},S.every=S.all=function(e,t,r){var i=!0;return e==null?i:v&&e.every===v?e.every(t,r):(x(e,function(e,s,o){if(!(i=i&&t.call(r,e,s,o)))return n}),i)};var T=S.some=S.any=function(e,t,r){t||(t=S.identity);var i=!1;return e==null?i:m&&e.some===m?e.some(t,r):(x(e,function(e,s,o){if(i||(i=t.call(r,e,s,o)))return n}),!!i)};S.include=S.contains=function(e,t){var n=!1;return e==null?n:g&&e.indexOf===g?e.indexOf(t)!=-1:(n=T(e,function(e){return e===t}),n)},S.invoke=function(e,t){var n=o.call(arguments,2);return S.map(e,function(e){return(S.isFunction(t)?t||e:e[t]).apply(e,n)})},S.pluck=function(e,t){return S.map(e,function(e){return e[t]})},S.max=function(e,t,n){if(!t&&S.isArray(e))return Math.max.apply(Math,e);if(!t&&S.isEmpty(e))return-Infinity;var r={computed:-Infinity};return x(e,function(e,i,s){var o=t?t.call(n,e,i,s):e;o>=r.computed&&(r={value:e,computed:o})}),r.value},S.min=function(e,t,n){if(!t&&S.isArray(e))return Math.min.apply(Math,e);if(!t&&S.isEmpty(e))return Infinity;var r={computed:Infinity};return x(e,function(e,i,s){var o=t?t.call(n,e,i,s):e;o<r.computed&&(r={value:e,computed:o})}),r.value},S.shuffle=function(e){var t=[],n;return x(e,function(e,r,i){r==0?t[0]=e:(n=Math.floor(Math.random()*(r+1)),t[r]=t[n],t[n]=e)}),t},S.sortBy=function(e,t,n){return S.pluck(S.map(e,function(e,r,i){return{value:e,criteria:t.call(n,e,r,i)}}).sort(function(e,t){var n=e.criteria,r=t.criteria;return n<r?-1:n>r?1:0}),"value")},S.groupBy=function(e,t){var n={},r=S.isFunction(t)?t:function(e){return e[t]};return x(e,function(e,t){var i=r(e,t);(n[i]||(n[i]=[])).push(e)}),n},S.sortedIndex=function(e,t,n){n||(n=S.identity);var r=0,i=e.length;while(r<i){var s=r+i>>1;n(e[s])<n(t)?r=s+1:i=s}return r},S.toArray=function(e){return e?e.toArray?e.toArray():S.isArray(e)?o.call(e):S.isArguments(e)?o.call(e):S.values(e):[]},S.size=function(e){return S.toArray(e).length},S.first=S.head=function(e,t,n){return t!=null&&!n?o.call(e,0,t):e[0]},S.initial=function(e,t,n){return o.call(e,0,e.length-(t==null||n?1:t))},S.last=function(e,t,n){return t!=null&&!n?o.call(e,Math.max(e.length-t,0)):e[e.length-1]},S.rest=S.tail=function(e,t,n){return o.call(e,t==null||n?1:t)},S.compact=function(e){return S.filter(e,function(e){return!!e})},S.flatten=function(e,t){return S.reduce(e,function(e,n){return S.isArray(n)?e.concat(t?n:S.flatten(n)):(e[e.length]=n,e)},[])},S.without=function(e){return S.difference(e,o.call(arguments,1))},S.uniq=S.unique=function(e,t,n){var r=n?S.map(e,n):e,i=[];return S.reduce(r,function(n,r,s){if(0==s||(t===!0?S.last(n)!=r:!S.include(n,r)))n[n.length]=r,i[i.length]=e[s];return n},[]),i},S.union=function(){return S.uniq(S.flatten(arguments,!0))},S.intersection=S.intersect=function(e){var t=o.call(arguments,1);return S.filter(S.uniq(e),function(e){return S.every(t,function(t){return S.indexOf(t,e)>=0})})},S.difference=function(e){var t=S.flatten(o.call(arguments,1));return S.filter(e,function(e){return!S.include(t,e)})},S.zip=function(){var e=o.call(arguments),t=S.max(S.pluck(e,"length")),n=new Array(t);for(var r=0;r<t;r++)n[r]=S.pluck(e,""+r);return n},S.indexOf=function(e,t,n){if(e==null)return-1;var r,i;if(n)return r=S.sortedIndex(e,t),e[r]===t?r:-1;if(g&&e.indexOf===g)return e.indexOf(t);for(r=0,i=e.length;r<i;r++)if(r in e&&e[r]===t)return r;return-1},S.lastIndexOf=function(e,t){if(e==null)return-1;if(y&&e.lastIndexOf===y)return e.lastIndexOf(t);var n=e.length;while(n--)if(n in e&&e[n]===t)return n;return-1},S.range=function(e,t,n){arguments.length<=1&&(t=e||0,e=0),n=arguments[2]||1;var r=Math.max(Math.ceil((t-e)/n),0),i=0,s=new Array(r);while(i<r)s[i++]=e,e+=n;return s};var N=function(){};S.bind=function(t,n){var r,i;if(t.bind===E&&E)return E.apply(t,o.call(arguments,1));if(!S.isFunction(t))throw new TypeError;return i=o.call(arguments,2),r=function(){if(this instanceof r){N.prototype=t.prototype;var e=new N,s=t.apply(e,i.concat(o.call(arguments)));return Object(s)===s?s:e}return t.apply(n,i.concat(o.call(arguments)))}},S.bindAll=function(e){var t=o.call(arguments,1);return t.length==0&&(t=S.functions(e)),x(t,function(t){e[t]=S.bind(e[t],e)}),e},S.memoize=function(e,t){var n={};return t||(t=S.identity),function(){var r=t.apply(this,arguments);return S.has(n,r)?n[r]:n[r]=e.apply(this,arguments)}},S.delay=function(e,t){var n=o.call(arguments,2);return setTimeout(function(){return e.apply(e,n)},t)},S.defer=function(e){return S.delay.apply(S,[e,1].concat(o.call(arguments,1)))},S.throttle=function(e,t){var n,r,i,s,o,u=S.debounce(function(){o=s=!1},t);return function(){n=this,r=arguments;var a=function(){i=null,o&&e.apply(n,r),u()};i||(i=setTimeout(a,t)),s?o=!0:e.apply(n,r),u(),s=!0}},S.debounce=function(e,t){var n;return function(){var r=this,i=arguments,s=function(){n=null,e.apply(r,i)};clearTimeout(n),n=setTimeout(s,t)}},S.once=function(e){var t=!1,n;return function(){return t?n:(t=!0,n=e.apply(this,arguments))}},S.wrap=function(e,t){return function(){var n=[e].concat(o.call(arguments,0));return t.apply(this,n)}},S.compose=function(){var e=arguments;return function(){var t=arguments;for(var n=e.length-1;n>=0;n--)t=[e[n].apply(this,t)];return t[0]}},S.after=function(e,t){return e<=0?t():function(){if(--e<1)return t.apply(this,arguments)}},S.keys=w||function(e){if(e!==Object(e))throw new TypeError("Invalid object");var t=[];for(var n in e)S.has(e,n)&&(t[t.length]=n);return t},S.values=function(e){return S.map(e,S.identity)},S.functions=S.methods=function(e){var t=[];for(var n in e)S.isFunction(e[n])&&t.push(n);return t.sort()},S.extend=function(e){return x(o.call(arguments,1),function(t){for(var n in t)e[n]=t[n]}),e},S.defaults=function(e){return x(o.call(arguments,1),function(t){for(var n in t)e[n]==null&&(e[n]=t[n])}),e},S.clone=function(e){return S.isObject(e)?S.isArray(e)?e.slice():S.extend({},e):e},S.tap=function(e,t){return t(e),e},S.isEqual=function(e,t){return C(e,t,[])},S.isEmpty=function(e){if(S.isArray(e)||S.isString(e))return e.length===0;for(var t in e)if(S.has(e,t))return!1;return!0},S.isElement=function(e){return!!e&&e.nodeType==1},S.isArray=b||function(e){return a.call(e)=="[object Array]"},S.isObject=function(e){return e===Object(e)},S.isArguments=function(e){return a.call(e)=="[object Arguments]"},S.isArguments(arguments)||(S.isArguments=function(e){return!!e&&!!S.has(e,"callee")}),S.isFunction=function(e){return a.call(e)=="[object Function]"},S.isString=function(e){return a.call(e)=="[object String]"},S.isNumber=function(e){return a.call(e)=="[object Number]"},S.isNaN=function(e){return e!==e},S.isBoolean=function(e){return e===!0||e===!1||a.call(e)=="[object Boolean]"},S.isDate=function(e){return a.call(e)=="[object Date]"},S.isRegExp=function(e){return a.call(e)=="[object RegExp]"},S.isNull=function(e){return e===null},S.isUndefined=function(e){return e===void 0},S.has=function(e,t){return f.call(e,t)},S.noConflict=function(){return e._=t,this},S.identity=function(e){return e},S.times=function(e,t,n){for(var r=0;r<e;r++)t.call(n,r)},S.escape=function(e){return(""+e).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#x27;").replace(/\//g,"&#x2F;")},S.mixin=function(e){x(S.functions(e),function(t){_(t,S[t]=e[t])})};var k=0;S.uniqueId=function(e){var t=k++;return e?e+t:t},S.templateSettings={evaluate:/<%([\s\S]+?)%>/g,interpolate:/<%=([\s\S]+?)%>/g,escape:/<%-([\s\S]+?)%>/g};var L=/.^/,A=function(e){return e.replace(/\\\\/g,"\\").replace(/\\'/g,"'")};S.template=function(e,t){var n=S.templateSettings,r="var __p=[],print=function(){__p.push.apply(__p,arguments);};with(obj||{}){__p.push('"+e.replace(/\\/g,"\\\\").replace(/'/g,"\\'").replace(n.escape||L,function(e,t){return"',_.escape("+A(t)+"),'"}).replace(n.interpolate||L,function(e,t){return"',"+A(t)+",'"}).replace(n.evaluate||L,function(e,t){return"');"+A(t).replace(/[\r\n\t]/g," ")+";__p.push('"}).replace(/\r/g,"\\r").replace(/\n/g,"\\n").replace(/\t/g,"\\t")+"');}return __p.join('');",i=new Function("obj","_",r);return t?i(t,S):function(e){return i.call(this,e,S)}},S.chain=function(e){return S(e).chain()};var O=function(e){this._wrapped=e};S.prototype=O.prototype;var M=function(e,t){return t?S(e).chain():e},_=function(e,t){O.prototype[e]=function(){var e=o.call(arguments);return u.call(e,this._wrapped),M(t.apply(S,e),this._chain)}};S.mixin(S),x(["pop","push","reverse","shift","sort","splice","unshift"],function(e){var t=r[e];O.prototype[e]=function(){var n=this._wrapped;t.apply(n,arguments);var r=n.length;return(e=="shift"||e=="splice")&&r===0&&delete n[0],M(n,this._chain)}}),x(["concat","join","slice"],function(e){var t=r[e];O.prototype[e]=function(){return M(t.apply(this._wrapped,arguments),this._chain)}}),O.prototype.chain=function(){return this._chain=!0,this},O.prototype.value=function(){return this._wrapped}}.call(this),define("underscore",function(){}),define("use!underscore",[],function(){return window._}),function(){var e=this,t=e.Backbone,n=Array.prototype.slice,r=Array.prototype.splice,i;typeof exports!="undefined"?i=exports:i=e.Backbone={},i.VERSION="0.9.2";var s=e._;!s&&typeof require!="undefined"&&(s=require("underscore"));var o=e.jQuery||e.Zepto||e.ender;i.setDomLibrary=function(e){o=e},i.noConflict=function(){return e.Backbone=t,this},i.emulateHTTP=!1,i.emulateJSON=!1;var u=/\s+/,a=i.Events={on:function(e,t,n){var r,i,s,o,a;if(!t)return this;e=e.split(u),r=this._callbacks||(this._callbacks={});while(i=e.shift())a=r[i],s=a?a.tail:{},s.next=o={},s.context=n,s.callback=t,r[i]={tail:o,next:a?a.next:s};return this},off:function(e,t,n){var r,i,o,a,f,l;if(!(i=this._callbacks))return;if(!(e||t||n))return delete this._callbacks,this;e=e?e.split(u):s.keys(i);while(r=e.shift()){o=i[r],delete i[r];if(!o||!t&&!n)continue;a=o.tail;while((o=o.next)!==a)f=o.callback,l=o.context,(t&&f!==t||n&&l!==n)&&this.on(r,f,l)}return this},trigger:function(e){var t,r,i,s,o,a,f;if(!(i=this._callbacks))return this;a=i.all,e=e.split(u),f=n.call(arguments,1);while(t=e.shift()){if(r=i[t]){s=r.tail;while((r=r.next)!==s)r.callback.apply(r.context||this,f)}if(r=a){s=r.tail,o=[t].concat(f);while((r=r.next)!==s)r.callback.apply(r.context||this,o)}}return this}};a.bind=a.on,a.unbind=a.off;var f=i.Model=function(e,t){var n;e||(e={}),t&&t.parse&&(e=this.parse(e));if(n=C(this,"defaults"))e=s.extend({},n,e);t&&t.collection&&(this.collection=t.collection),this.attributes={},this._escapedAttributes={},this.cid=s.uniqueId("c"),this.changed={},this._silent={},this._pending={},this.set(e,{silent:!0}),this.changed={},this._silent={},this._pending={},this._previousAttributes=s.clone(this.attributes),this.initialize.apply(this,arguments)};s.extend(f.prototype,a,{changed:null,_silent:null,_pending:null,idAttribute:"id",initialize:function(){},toJSON:function(e){return s.clone(this.attributes)},get:function(e){return this.attributes[e]},escape:function(e){var t;if(t=this._escapedAttributes[e])return t;var n=this.get(e);return this._escapedAttributes[e]=s.escape(n==null?"":""+n)},has:function(e){return this.get(e)!=null},set:function(e,t,n){var r,i,o;s.isObject(e)||e==null?(r=e,n=t):(r={},r[e]=t),n||(n={});if(!r)return this;r instanceof f&&(r=r.attributes);if(n.unset)for(i in r)r[i]=void 0;if(!this._validate(r,n))return!1;this.idAttribute in r&&(this.id=r[this.idAttribute]);var u=n.changes={},a=this.attributes,l=this._escapedAttributes,c=this._previousAttributes||{};for(i in r){o=r[i];if(!s.isEqual(a[i],o)||n.unset&&s.has(a,i))delete l[i],(n.silent?this._silent:u)[i]=!0;n.unset?delete a[i]:a[i]=o,!s.isEqual(c[i],o)||s.has(a,i)!=s.has(c,i)?(this.changed[i]=o,n.silent||(this._pending[i]=!0)):(delete this.changed[i],delete this._pending[i])}return n.silent||this.change(n),this},unset:function(e,t){return(t||(t={})).unset=!0,this.set(e,null,t)},clear:function(e){return(e||(e={})).unset=!0,this.set(s.clone(this.attributes),e)},fetch:function(e){e=e?s.clone(e):{};var t=this,n=e.success;return e.success=function(r,i,s){if(!t.set(t.parse(r,s),e))return!1;n&&n(t,r)},e.error=i.wrapError(e.error,t,e),(this.sync||i.sync).call(this,"read",this,e)},save:function(e,t,n){var r,o;s.isObject(e)||e==null?(r=e,n=t):(r={},r[e]=t),n=n?s.clone(n):{};if(n.wait){if(!this._validate(r,n))return!1;o=s.clone(this.attributes)}var u=s.extend({},n,{silent:!0});if(r&&!this.set(r,n.wait?u:n))return!1;var a=this,f=n.success;n.success=function(e,t,i){var o=a.parse(e,i);n.wait&&(delete n.wait,o=s.extend(r||{},o));if(!a.set(o,n))return!1;f?f(a,e):a.trigger("sync",a,e,n)},n.error=i.wrapError(n.error,a,n);var l=this.isNew()?"create":"update",c=(this.sync||i.sync).call(this,l,this,n);return n.wait&&this.set(o,u),c},destroy:function(e){e=e?s.clone(e):{};var t=this,n=e.success,r=function(){t.trigger("destroy",t,t.collection,e)};if(this.isNew())return r(),!1;e.success=function(i){e.wait&&r(),n?n(t,i):t.trigger("sync",t,i,e)},e.error=i.wrapError(e.error,t,e);var o=(this.sync||i.sync).call(this,"delete",this,e);return e.wait||r(),o},url:function(){var e=C(this,"urlRoot")||C(this.collection,"url")||k();return this.isNew()?e:e+(e.charAt(e.length-1)=="/"?"":"/")+encodeURIComponent(this.id)},parse:function(e,t){return e},clone:function(){return new this.constructor(this.attributes)},isNew:function(){return this.id==null},change:function(e){e||(e={});var t=this._changing;this._changing=!0;for(var n in this._silent)this._pending[n]=!0;var r=s.extend({},e.changes,this._silent);this._silent={};for(var n in r)this.trigger("change:"+n,this,this.get(n),e);if(t)return this;while(!s.isEmpty(this._pending)){this._pending={},this.trigger("change",this,e);for(var n in this.changed){if(this._pending[n]||this._silent[n])continue;delete this.changed[n]}this._previousAttributes=s.clone(this.attributes)}return this._changing=!1,this},hasChanged:function(e){return arguments.length?s.has(this.changed,e):!s.isEmpty(this.changed)},changedAttributes:function(e){if(!e)return this.hasChanged()?s.clone(this.changed):!1;var t,n=!1,r=this._previousAttributes;for(var i in e){if(s.isEqual(r[i],t=e[i]))continue;(n||(n={}))[i]=t}return n},previous:function(e){return!arguments.length||!this._previousAttributes?null:this._previousAttributes[e]},previousAttributes:function(){return s.clone(this._previousAttributes)},isValid:function(){return!this.validate(this.attributes)},_validate:function(e,t){if(t.silent||!this.validate)return!0;e=s.extend({},this.attributes,e);var n=this.validate(e,t);return n?(t&&t.error?t.error(this,n,t):this.trigger("error",this,n,t),!1):!0}});var l=i.Collection=function(e,t){t||(t={}),t.model&&(this.model=t.model),t.comparator&&(this.comparator=t.comparator),this._reset(),this.initialize.apply(this,arguments),e&&this.reset(e,{silent:!0,parse:t.parse})};s.extend(l.prototype,a,{model:f,initialize:function(){},toJSON:function(e){return this.map(function(t){return t.toJSON(e)})},add:function(e,t){var n,i,o,u,a,f,l={},c={},h=[];t||(t={}),e=s.isArray(e)?e.slice():[e];for(n=0,o=e.length;n<o;n++){if(!(u=e[n]=this._prepareModel(e[n],t)))throw new Error("Can't add an invalid model to a collection");a=u.cid,f=u.id;if(l[a]||this._byCid[a]||f!=null&&(c[f]||this._byId[f])){h.push(n);continue}l[a]=c[f]=u}n=h.length;while(n--)e.splice(h[n],1);for(n=0,o=e.length;n<o;n++)(u=e[n]).on("all",this._onModelEvent,this),this._byCid[u.cid]=u,u.id!=null&&(this._byId[u.id]=u);this.length+=o,i=t.at!=null?t.at:this.models.length,r.apply(this.models,[i,0].concat(e)),this.comparator&&this.sort({silent:!0});if(t.silent)return this;for(n=0,o=this.models.length;n<o;n++){if(!l[(u=this.models[n]).cid])continue;t.index=n,u.trigger("add",u,this,t)}return this},remove:function(e,t){var n,r,i,o;t||(t={}),e=s.isArray(e)?e.slice():[e];for(n=0,r=e.length;n<r;n++){o=this.getByCid(e[n])||this.get(e[n]);if(!o)continue;delete this._byId[o.id],delete this._byCid[o.cid],i=this.indexOf(o),this.models.splice(i,1),this.length--,t.silent||(t.index=i,o.trigger("remove",o,this,t)),this._removeReference(o)}return this},push:function(e,t){return e=this._prepareModel(e,t),this.add(e,t),e},pop:function(e){var t=this.at(this.length-1);return this.remove(t,e),t},unshift:function(e,t){return e=this._prepareModel(e,t),this.add(e,s.extend({at:0},t)),e},shift:function(e){var t=this.at(0);return this.remove(t,e),t},get:function(e){return e==null?void 0:this._byId[e.id!=null?e.id:e]},getByCid:function(e){return e&&this._byCid[e.cid||e]},at:function(e){return this.models[e]},where:function(e){return s.isEmpty(e)?[]:this.filter(function(t){for(var n in e)if(e[n]!==t.get(n))return!1;return!0})},sort:function(e){e||(e={});if(!this.comparator)throw new Error("Cannot sort a set without a comparator");var t=s.bind(this.comparator,this);return this.comparator.length==1?this.models=this.sortBy(t):this.models.sort(t),e.silent||this.trigger("reset",this,e),this},pluck:function(e){return s.map(this.models,function(t){return t.get(e)})},reset:function(e,t){e||(e=[]),t||(t={});for(var n=0,r=this.models.length;n<r;n++)this._removeReference(this.models[n]);return this._reset(),this.add(e,s.extend({silent:!0},t)),t.silent||this.trigger("reset",this,t),this},fetch:function(e){e=e?s.clone(e):{},e.parse===undefined&&(e.parse=!0);var t=this,n=e.success;return e.success=function(r,i,s){t[e.add?"add":"reset"](t.parse(r,s),e),n&&n(t,r)},e.error=i.wrapError(e.error,t,e),(this.sync||i.sync).call(this,"read",this,e)},create:function(e,t){var n=this;t=t?s.clone(t):{},e=this._prepareModel(e,t);if(!e)return!1;t.wait||n.add(e,t);var r=t.success;return t.success=function(i,s,o){t.wait&&n.add(i,t),r?r(i,s):i.trigger("sync",e,s,t)},e.save(null,t),e},parse:function(e,t){return e},chain:function(){return s(this.models).chain()},_reset:function(e){this.length=0,this.models=[],this._byId={},this._byCid={}},_prepareModel:function(e,t){t||(t={});if(e instanceof f)e.collection||(e.collection=this);else{var n=e;t.collection=this,e=new this.model(n,t),e._validate(e.attributes,t)||(e=!1)}return e},_removeReference:function(e){this==e.collection&&delete e.collection,e.off("all",this._onModelEvent,this)},_onModelEvent:function(e,t,n,r){if((e=="add"||e=="remove")&&n!=this)return;e=="destroy"&&this.remove(t,r),t&&e==="change:"+t.idAttribute&&(delete this._byId[t.previous(t.idAttribute)],this._byId[t.id]=t),this.trigger.apply(this,arguments)}});var c=["forEach","each","map","reduce","reduceRight","find","detect","filter","select","reject","every","all","some","any","include","contains","invoke","max","min","sortBy","sortedIndex","toArray","size","first","initial","rest","last","without","indexOf","shuffle","lastIndexOf","isEmpty","groupBy"];s.each(c,function(e){l.prototype[e]=function(){return s[e].apply(s,[this.models].concat(s.toArray(arguments)))}});var h=i.Router=function(e){e||(e={}),e.routes&&(this.routes=e.routes),this._bindRoutes(),this.initialize.apply(this,arguments)},p=/:\w+/g,d=/\*\w+/g,v=/[-[\]{}()+?.,\\^$|#\s]/g;s.extend(h.prototype,a,{initialize:function(){},route:function(e,t,n){return i.history||(i.history=new m),s.isRegExp(e)||(e=this._routeToRegExp(e)),n||(n=this[t]),i.history.route(e,s.bind(function(r){var s=this._extractParameters(e,r);n&&n.apply(this,s),this.trigger.apply(this,["route:"+t].concat(s)),i.history.trigger("route",this,t,s)},this)),this},navigate:function(e,t){i.history.navigate(e,t)},_bindRoutes:function(){if(!this.routes)return;var e=[];for(var t in this.routes)e.unshift([t,this.routes[t]]);for(var n=0,r=e.length;n<r;n++)this.route(e[n][0],e[n][1],this[e[n][1]])},_routeToRegExp:function(e){return e=e.replace(v,"\\$&").replace(p,"([^/]+)").replace(d,"(.*?)"),new RegExp("^"+e+"$")},_extractParameters:function(e,t){return e.exec(t).slice(1)}});var m=i.History=function(){this.handlers=[],s.bindAll(this,"checkUrl")},g=/^[#\/]/,y=/msie [\w.]+/;m.started=!1,s.extend(m.prototype,a,{interval:50,getHash:function(e){var t=e?e.location:window.location,n=t.href.match(/#(.*)$/);return n?n[1]:""},getFragment:function(e,t){if(e==null)if(this._hasPushState||t){e=window.location.pathname;var n=window.location.search;n&&(e+=n)}else e=this.getHash();return e.indexOf(this.options.root)||(e=e.substr(this.options.root.length)),e.replace(g,"")},start:function(e){if(m.started)throw new Error("Backbone.history has already been started");m.started=!0,this.options=s.extend({},{root:"/"},this.options,e),this._wantsHashChange=this.options.hashChange!==!1,this._wantsPushState=!!this.options.pushState,this._hasPushState=!!(this.options.pushState&&window.history&&window.history.pushState);var t=this.getFragment(),n=document.documentMode,r=y.exec(navigator.userAgent.toLowerCase())&&(!n||n<=7);r&&(this.iframe=o('<iframe src="javascript:0" tabindex="-1" />').hide().appendTo("body")[0].contentWindow,this.navigate(t)),this._hasPushState?o(window).bind("popstate",this.checkUrl):this._wantsHashChange&&"onhashchange"in window&&!r?o(window).bind("hashchange",this.checkUrl):this._wantsHashChange&&(this._checkUrlInterval=setInterval(this.checkUrl,this.interval)),this.fragment=t;var i=window.location,u=i.pathname==this.options.root;if(this._wantsHashChange&&this._wantsPushState&&!this._hasPushState&&!u)return this.fragment=this.getFragment(null,!0),window.location.replace(this.options.root+"#"+this.fragment),!0;this._wantsPushState&&this._hasPushState&&u&&i.hash&&(this.fragment=this.getHash().replace(g,""),window.history.replaceState({},document.title,i.protocol+"//"+i.host+this.options.root+this.fragment));if(!this.options.silent)return this.loadUrl()},stop:function(){o(window).unbind("popstate",this.checkUrl).unbind("hashchange",this.checkUrl),clearInterval(this._checkUrlInterval),m.started=!1},route:function(e,t){this.handlers.unshift({route:e,callback:t})},checkUrl:function(e){var t=this.getFragment();t==this.fragment&&this.iframe&&(t=this.getFragment(this.getHash(this.iframe)));if(t==this.fragment)return!1;this.iframe&&this.navigate(t),this.loadUrl()||this.loadUrl(this.getHash())},loadUrl:function(e){var t=this.fragment=this.getFragment(e),n=s.any(this.handlers,function(e){if(e.route.test(t))return e.callback(t),!0});return n},navigate:function(e,t){if(!m.started)return!1;if(!t||t===!0)t={trigger:t};var n=(e||"").replace(g,"");if(this.fragment==n)return;this._hasPushState?(n.indexOf(this.options.root)!=0&&(n=this.options.root+n),this.fragment=n,window.history[t.replace?"replaceState":"pushState"]({},document.title,n)):this._wantsHashChange?(this.fragment=n,this._updateHash(window.location,n,t.replace),this.iframe&&n!=this.getFragment(this.getHash(this.iframe))&&(t.replace||this.iframe.document.open().close(),this._updateHash(this.iframe.location,n,t.replace))):window.location.assign(this.options.root+e),t.trigger&&this.loadUrl(e)},_updateHash:function(e,t,n){n?e.replace(e.toString().replace(/(javascript:|#).*$/,"")+"#"+t):e.hash=t}});var b=i.View=function(e){this.cid=s.uniqueId("view"),this._configure(e||{}),this._ensureElement(),this.initialize.apply(this,arguments),this.delegateEvents()},w=/^(\S+)\s*(.*)$/,E=["model","collection","el","id","attributes","className","tagName"];s.extend(b.prototype,a,{tagName:"div",$:function(e){return this.$el.find(e)},initialize:function(){},render:function(){return this},remove:function(){return this.$el.remove(),this},make:function(e,t,n){var r=document.createElement(e);return t&&o(r).attr(t),n&&o(r).html(n),r},setElement:function(e,t){return this.$el&&this.undelegateEvents(),this.$el=e instanceof o?e:o(e),this.el=this.$el[0],t!==!1&&this.delegateEvents(),this},delegateEvents:function(e){if(!e&&!(e=C(this,"events")))return;this.undelegateEvents();for(var t in e){var n=e[t];s.isFunction(n)||(n=this[e[t]]);if(!n)throw new Error('Method "'+e[t]+'" does not exist');var r=t.match(w),i=r[1],o=r[2];n=s.bind(n,this),i+=".delegateEvents"+this.cid,o===""?this.$el.bind(i,n):this.$el.delegate(o,i,n)}},undelegateEvents:function(){this.$el.unbind(".delegateEvents"+this.cid)},_configure:function(e){this.options&&(e=s.extend({},this.options,e));for(var t=0,n=E.length;t<n;t++){var r=E[t];e[r]&&(this[r]=e[r])}this.options=e},_ensureElement:function(){if(!this.el){var e=C(this,"attributes")||{};this.id&&(e.id=this.id),this.className&&(e["class"]=this.className),this.setElement(this.make(this.tagName,e),!1)}else this.setElement(this.el,!1)}});var S=function(e,t){var n=N(this,e,t);return n.extend=this.extend,n};f.extend=l.extend=h.extend=b.extend=S;var x={create:"POST",update:"PUT","delete":"DELETE",read:"GET"};i.sync=function(e,t,n){var r=x[e];n||(n={});var u={type:r,dataType:"json"};return n.url||(u.url=C(t,"url")||k()),!n.data&&t&&(e=="create"||e=="update")&&(u.contentType="application/json",u.data=JSON.stringify(t.toJSON())),i.emulateJSON&&(u.contentType="application/x-www-form-urlencoded",u.data=u.data?{model:u.data}:{}),i.emulateHTTP&&(r==="PUT"||r==="DELETE")&&(i.emulateJSON&&(u.data._method=r),u.type="POST",u.beforeSend=function(e){e.setRequestHeader("X-HTTP-Method-Override",r)}),u.type!=="GET"&&!i.emulateJSON&&(u.processData=!1),o.ajax(s.extend(u,n))},i.wrapError=function(e,t,n){return function(r,i){i=r===t?i:r,e?e(t,i,n):t.trigger("error",t,i,n)}};var T=function(){},N=function(e,t,n){var r;return t&&t.hasOwnProperty("constructor")?r=t.constructor:r=function(){e.apply(this,arguments)},s.extend(r,e),T.prototype=e.prototype,r.prototype=new T,t&&s.extend(r.prototype,t),n&&s.extend(r,n),r.prototype.constructor=r,r.__super__=e.prototype,r},C=function(e,t){return!e||!e[t]?null:s.isFunction(e[t])?e[t]():e[t]},k=function(){throw new Error('A "url" property or function must be specified')}}.call(this),define("backbone",function(){}),define("use!backbone",["use!underscore","jquery"],function(){return window.Backbone}),define("namespace",["jquery","use!underscore","use!backbone"],function(e,t,n){return{fetchTemplate:function(n,r){var i=window.JST=window.JST||{},s=new e.Deferred;return i[n]?(t.isFunction(r)&&r(i[n]),s.resolve(i[n])):(e.ajax({url:n,type:"get",dataType:"text",cache:!1,global:!1,success:function(e){i[n]=t.template(e),t.isFunction(r)&&r(i[n]),s.resolve(i[n])}}),s.promise())},module:function(e){return t.extend({Views:{}},e)},app:t.extend({},n.Events)}}),function(e,t){function n(t,n){var i=t.nodeName.toLowerCase();if("area"===i){var s=t.parentNode,o=s.name,u;return!t.href||!o||s.nodeName.toLowerCase()!=="map"?!1:(u=e("img[usemap=#"+o+"]")[0],!!u&&r(u))}return(/input|select|textarea|button|object/.test(i)?!t.disabled:"a"==i?t.href||n:n)&&r(t)}function r(t){return!e(t).parents().andSelf().filter(function(){return e.curCSS(this,"visibility")==="hidden"||e.expr.filters.hidden(this)}).length}e.ui=e.ui||{};if(e.ui.version)return;e.extend(e.ui,{version:"@VERSION",keyCode:{ALT:18,BACKSPACE:8,CAPS_LOCK:20,COMMA:188,COMMAND:91,COMMAND_LEFT:91,COMMAND_RIGHT:93,CONTROL:17,DELETE:46,DOWN:40,END:35,ENTER:13,ESCAPE:27,HOME:36,INSERT:45,LEFT:37,MENU:93,NUMPAD_ADD:107,NUMPAD_DECIMAL:110,NUMPAD_DIVIDE:111,NUMPAD_ENTER:108,NUMPAD_MULTIPLY:106,NUMPAD_SUBTRACT:109,PAGE_DOWN:34,PAGE_UP:33,PERIOD:190,RIGHT:39,SHIFT:16,SPACE:32,TAB:9,UP:38,WINDOWS:91}}),e.fn.extend({propAttr:e.fn.prop||e.fn.attr,_focus:e.fn.focus,focus:function(t,n){return typeof t=="number"?this.each(function(){var r=this;setTimeout(function(){e(r).focus(),n&&n.call(r)},t)}):this._focus.apply(this,arguments)},scrollParent:function(){var t;return e.browser.msie&&/(static|relative)/.test(this.css("position"))||/absolute/.test(this.css("position"))?t=this.parents().filter(function(){return/(relative|absolute|fixed)/.test(e.curCSS(this,"position",1))&&/(auto|scroll)/.test(e.curCSS(this,"overflow",1)+e.curCSS(this,"overflow-y",1)+e.curCSS(this,"overflow-x",1))}).eq(0):t=this.parents().filter(function(){return/(auto|scroll)/.test(e.curCSS(this,"overflow",1)+e.curCSS(this,"overflow-y",1)+e.curCSS(this,"overflow-x",1))}).eq(0),/fixed/.test(this.css("position"))||!t.length?e(document):t},zIndex:function(n){if(n!==t)return this.css("zIndex",n);if(this.length){var r=e(this[0]),i,s;while(r.length&&r[0]!==document){i=r.css("position");if(i==="absolute"||i==="relative"||i==="fixed"){s=parseInt(r.css("zIndex"),10);if(!isNaN(s)&&s!==0)return s}r=r.parent()}}return 0},disableSelection:function(){return this.bind((e.support.selectstart?"selectstart":"mousedown")+".ui-disableSelection",function(e){e.preventDefault()})},enableSelection:function(){return this.unbind(".ui-disableSelection")}}),e.each(["Width","Height"],function(n,r){function u(t,n,r,s){return e.each(i,function(){n-=parseFloat(e.curCSS(t,"padding"+this,!0))||0,r&&(n-=parseFloat(e.curCSS(t,"border"+this+"Width",!0))||0),s&&(n-=parseFloat(e.curCSS(t,"margin"+this,!0))||0)}),n}var i=r==="Width"?["Left","Right"]:["Top","Bottom"],s=r.toLowerCase(),o={innerWidth:e.fn.innerWidth,innerHeight:e.fn.innerHeight,outerWidth:e.fn.outerWidth,outerHeight:e.fn.outerHeight};e.fn["inner"+r]=function(n){return n===t?o["inner"+r].call(this):this.each(function(){e(this).css(s,u(this,n)+"px")})},e.fn["outer"+r]=function(t,n){return typeof t!="number"?o["outer"+r].call(this,t):this.each(function(){e(this).css(s,u(this,t,!0,n)+"px")})}}),e.extend(e.expr[":"],{data:function(t,n,r){return!!e.data(t,r[3])},focusable:function(t){return n(t,!isNaN(e.attr(t,"tabindex")))},tabbable:function(t){var r=e.attr(t,"tabindex"),i=isNaN(r);return(i||r>=0)&&n(t,!i)}}),e(function(){var t=document.body,n=t.appendChild(n=document.createElement("div"));n.offsetHeight,e.extend(n.style,{minHeight:"100px",height:"auto",padding:0,borderWidth:0}),e.support.minHeight=n.offsetHeight===100,e.support.selectstart="onselectstart"in n,t.removeChild(n).style.display="none"}),e.extend(e.ui,{plugin:{add:function(t,n,r){var i=e.ui[t].prototype;for(var s in r)i.plugins[s]=i.plugins[s]||[],i.plugins[s].push([n,r[s]])},call:function(e,t,n){var r=e.plugins[t];if(!r||!e.element[0].parentNode)return;for(var i=0;i<r.length;i++)e.options[r[i][0]]&&r[i][1].apply(e.element,n)}},contains:function(e,t){return document.compareDocumentPosition?e.compareDocumentPosition(t)&16:e!==t&&e.contains(t)},hasScroll:function(t,n){if(e(t).css("overflow")==="hidden")return!1;var r=n&&n==="left"?"scrollLeft":"scrollTop",i=!1;return t[r]>0?!0:(t[r]=1,i=t[r]>0,t[r]=0,i)},isOverAxis:function(e,t,n){return e>t&&e<t+n},isOver:function(t,n,r,i,s,o){return e.ui.isOverAxis(t,r,s)&&e.ui.isOverAxis(n,i,o)}})}(jQuery),function(e,t){if(e.cleanData){var n=e.cleanData;e.cleanData=function(t){for(var r=0,i;(i=t[r])!=null;r++)try{e(i).triggerHandler("remove")}catch(s){}n(t)}}else{var r=e.fn.remove;e.fn.remove=function(t,n){return this.each(function(){return n||(!t||e.filter(t,[this]).length)&&e("*",this).add([this]).each(function(){try{e(this).triggerHandler("remove")}catch(t){}}),r.call(e(this),t,n)})}}e.widget=function(t,n,r){var i=t.split(".")[0],s;t=t.split(".")[1],s=i+"-"+t,r||(r=n,n=e.Widget),e.expr[":"][s]=function(n){return!!e.data(n,t)},e[i]=e[i]||{},e[i][t]=function(e,t){arguments.length&&this._createWidget(e,t)};var o=new n;o.options=e.extend(!0,{},o.options),e[i][t].prototype=e.extend(!0,o,{namespace:i,widgetName:t,widgetEventPrefix:e[i][t].prototype.widgetEventPrefix||t,widgetBaseClass:s},r),e.widget.bridge(t,e[i][t])},e.widget.bridge=function(n,r){e.fn[n]=function(i){var s=typeof i=="string",o=Array.prototype.slice.call(arguments,1),u=this;return i=!s&&o.length?e.extend.apply(null,[!0,i].concat(o)):i,s&&i.charAt(0)==="_"?u:(s?this.each(function(){var r=e.data(this,n),s=r&&e.isFunction(r[i])?r[i].apply(r,o):r;if(s!==r&&s!==t)return u=s,!1}):this.each(function(){var t=e.data(this,n);t?t.option(i||{})._init():e.data(this,n,new r(i,this))}),u)}},e.Widget=function(e,t){arguments.length&&this._createWidget(e,t)},e.Widget.prototype={widgetName:"widget",widgetEventPrefix:"",options:{disabled:!1},_createWidget:function(t,n){e.data(n,this.widgetName,this),this.element=e(n),this.options=e.extend(!0,{},this.options,this._getCreateOptions(),t);var r=this;this.element.bind("remove."+this.widgetName,function(){r.destroy()}),this._create(),this._trigger("create"),this._init()},_getCreateOptions:function(){return e.metadata&&e.metadata.get(this.element[0])[this.widgetName]},_create:function(){},_init:function(){},destroy:function(){this.element.unbind("."+this.widgetName).removeData(this.widgetName),this.widget().unbind("."+this.widgetName).removeAttr("aria-disabled").removeClass(this.widgetBaseClass+"-disabled "+"ui-state-disabled")},widget:function(){return this.element},option:function(n,r){var i=n;if(arguments.length===0)return e.extend({},this.options);if(typeof n=="string"){if(r===t)return this.options[n];i={},i[n]=r}return this._setOptions(i),this},_setOptions:function(t){var n=this;return e.each(t,function(e,t){n._setOption(e,t)}),this},_setOption:function(e,t){return this.options[e]=t,e==="disabled"&&this.widget()[t?"addClass":"removeClass"](this.widgetBaseClass+"-disabled"+" "+"ui-state-disabled").attr("aria-disabled",t),this},enable:function(){return this._setOption("disabled",!1)},disable:function(){return this._setOption("disabled",!0)},_trigger:function(t,n,r){var i,s,o=this.options[t];r=r||{},n=e.Event(n),n.type=(t===this.widgetEventPrefix?t:this.widgetEventPrefix+t).toLowerCase(),n.target=this.element[0],s=n.originalEvent;if(s)for(i in s)i in n||(n[i]=s[i]);return this.element.trigger(n,r),!(e.isFunction(o)&&o.call(this.element[0],n,r)===!1||n.isDefaultPrevented())}}}(jQuery),function(e,t){var n=!1;e(document).mouseup(function(e){n=!1}),e.widget("ui.mouse",{options:{cancel:":input,option",distance:1,delay:0},_mouseInit:function(){var t=this;this.element.bind("mousedown."+this.widgetName,function(e){return t._mouseDown(e)}).bind("click."+this.widgetName,function(n){if(!0===e.data(n.target,t.widgetName+".preventClickEvent"))return e.removeData(n.target,t.widgetName+".preventClickEvent"),n.stopImmediatePropagation(),!1}),this.started=!1},_mouseDestroy:function(){this.element.unbind("."+this.widgetName),e(document).unbind("mousemove."+this.widgetName,this._mouseMoveDelegate).unbind("mouseup."+this.widgetName,this._mouseUpDelegate)},_mouseDown:function(t){if(n)return;this._mouseStarted&&this._mouseUp(t),this._mouseDownEvent=t;var r=this,i=t.which==1,s=typeof this.options.cancel=="string"&&t.target.nodeName?e(t.target).closest(this.options.cancel).length:!1;if(!i||s||!this._mouseCapture(t))return!0;this.mouseDelayMet=!this.options.delay,this.mouseDelayMet||(this._mouseDelayTimer=setTimeout(function(){r.mouseDelayMet=!0},this.options.delay));if(this._mouseDistanceMet(t)&&this._mouseDelayMet(t)){this._mouseStarted=this._mouseStart(t)!==!1;if(!this._mouseStarted)return t.preventDefault(),!0}return!0===e.data(t.target,this.widgetName+".preventClickEvent")&&e.removeData(t.target,this.widgetName+".preventClickEvent"),this._mouseMoveDelegate=function(e){return r._mouseMove(e)},this._mouseUpDelegate=function(e){return r._mouseUp(e)},e(document).bind("mousemove."+this.widgetName,this._mouseMoveDelegate).bind("mouseup."+this.widgetName,this._mouseUpDelegate),t.preventDefault(),n=!0,!0},_mouseMove:function(t){return!e.browser.msie||document.documentMode>=9||!!t.button?this._mouseStarted?(this._mouseDrag(t),t.preventDefault()):(this._mouseDistanceMet(t)&&this._mouseDelayMet(t)&&(this._mouseStarted=this._mouseStart(this._mouseDownEvent,t)!==!1,this._mouseStarted?this._mouseDrag(t):this._mouseUp(t)),!this._mouseStarted):this._mouseUp(t)},_mouseUp:function(t){return e(document).unbind("mousemove."+this.widgetName,this._mouseMoveDelegate).unbind("mouseup."+this.widgetName,this._mouseUpDelegate),this._mouseStarted&&(this._mouseStarted=!1,t.target==this._mouseDownEvent.target&&e.data(t.target,this.widgetName+".preventClickEvent",!0),this._mouseStop(t)),!1},_mouseDistanceMet:function(e){return Math.max(Math.abs(this._mouseDownEvent.pageX-e.pageX),Math.abs(this._mouseDownEvent.pageY-e.pageY))>=this.options.distance},_mouseDelayMet:function(e){return this.mouseDelayMet},_mouseStart:function(e){},_mouseDrag:function(e){},_mouseStop:function(e){},_mouseCapture:function(e){return!0}})}(jQuery),function(e,t){e.widget("ui.draggable",e.ui.mouse,{widgetEventPrefix:"drag",options:{addClasses:!0,appendTo:"parent",axis:!1,connectToSortable:!1,containment:!1,cursor:"auto",cursorAt:!1,grid:!1,handle:!1,helper:"original",iframeFix:!1,opacity:!1,refreshPositions:!1,revert:!1,revertDuration:500,scope:"default",scroll:!0,scrollSensitivity:20,scrollSpeed:20,snap:!1,snapMode:"both",snapTolerance:20,stack:!1,zIndex:!1},_create:function(){this.options.helper=="original"&&!/^(?:r|a|f)/.test(this.element.css("position"))&&(this.element[0].style.position="relative"),this.options.addClasses&&this.element.addClass("ui-draggable"),this.options.disabled&&this.element.addClass("ui-draggable-disabled"),this._mouseInit()},destroy:function(){if(!this.element.data("draggable"))return;return this.element.removeData("draggable").unbind(".draggable").removeClass("ui-draggable ui-draggable-dragging ui-draggable-disabled"),this._mouseDestroy(),this},_mouseCapture:function(t){var n=this.options;return this.helper||n.disabled||e(t.target).is(".ui-resizable-handle")?!1:(this.handle=this._getHandle(t),this.handle?(n.iframeFix&&e(n.iframeFix===!0?"iframe":n.iframeFix).each(function(){e('<div class="ui-draggable-iframeFix" style="background: #fff;"></div>').css({width:this.offsetWidth+"px",height:this.offsetHeight+"px",position:"absolute",opacity:"0.001",zIndex:1e3}).css(e(this).offset()).appendTo("body")}),!0):!1)},_mouseStart:function(t){var n=this.options;return this.helper=this._createHelper(t),this._cacheHelperProportions(),e.ui.ddmanager&&(e.ui.ddmanager.current=this),this._cacheMargins(),this.cssPosition=this.helper.css("position"),this.scrollParent=this.helper.scrollParent(),this.offset=this.positionAbs=this.element.offset(),this.offset={top:this.offset.top-this.margins.top,left:this.offset.left-this.margins.left},e.extend(this.offset,{click:{left:t.pageX-this.offset.left,top:t.pageY-this.offset.top},parent:this._getParentOffset(),relative:this._getRelativeOffset()}),this.originalPosition=this.position=this._generatePosition(t),this.originalPageX=t.pageX,this.originalPageY=t.pageY,n.cursorAt&&this._adjustOffsetFromHelper(n.cursorAt),n.containment&&this._setContainment(),this._trigger("start",t)===!1?(this._clear(),!1):(this._cacheHelperProportions(),e.ui.ddmanager&&!n.dropBehaviour&&e.ui.ddmanager.prepareOffsets(this,t),this.helper.addClass("ui-draggable-dragging"),this._mouseDrag(t,!0),e.ui.ddmanager&&e.ui.ddmanager.dragStart(this,t),!0)},_mouseDrag:function(t,n){this.position=this._generatePosition(t),this.positionAbs=this._convertPositionTo("absolute");if(!n){var r=this._uiHash();if(this._trigger("drag",t,r)===!1)return this._mouseUp({}),!1;this.position=r.position}if(!this.options.axis||this.options.axis!="y")this.helper[0].style.left=this.position.left+"px";if(!this.options.axis||this.options.axis!="x")this.helper[0].style.top=this.position.top+"px";return e.ui.ddmanager&&e.ui.ddmanager.drag(this,t),!1},_mouseStop:function(t){var n=!1;e.ui.ddmanager&&!this.options.dropBehaviour&&(n=e.ui.ddmanager.drop(this,t)),this.dropped&&(n=this.dropped,this.dropped=!1);if((!this.element[0]||!this.element[0].parentNode)&&this.options.helper=="original")return!1;if(this.options.revert=="invalid"&&!n||this.options.revert=="valid"&&n||this.options.revert===!0||e.isFunction(this.options.revert)&&this.options.revert.call(this.element,n)){var r=this;e(this.helper).animate(this.originalPosition,parseInt(this.options.revertDuration,10),function(){r._trigger("stop",t)!==!1&&r._clear()})}else this._trigger("stop",t)!==!1&&this._clear();return!1},_mouseUp:function(t){return this.options.iframeFix===!0&&e("div.ui-draggable-iframeFix").each(function(){this.parentNode.removeChild(this)}),e.ui.ddmanager&&e.ui.ddmanager.dragStop(this,t),e.ui.mouse.prototype._mouseUp.call(this,t)},cancel:function(){return this.helper.is(".ui-draggable-dragging")?this._mouseUp({}):this._clear(),this},_getHandle:function(t){var n=!this.options.handle||!e(this.options.handle,this.element).length?!0:!1;return e(this.options.handle,this.element).find("*").andSelf().each(function(){this==t.target&&(n=!0)}),n},_createHelper:function(t){var n=this.options,r=e.isFunction(n.helper)?e(n.helper.apply(this.element[0],[t])):n.helper=="clone"?this.element.clone().removeAttr("id"):this.element;return r.parents("body").length||r.appendTo(n.appendTo=="parent"?this.element[0].parentNode:n.appendTo),r[0]!=this.element[0]&&!/(fixed|absolute)/.test(r.css("position"))&&r.css("position","absolute"),r},_adjustOffsetFromHelper:function(t){typeof t=="string"&&(t=t.split(" ")),e.isArray(t)&&(t={left:+t[0],top:+t[1]||0}),"left"in t&&(this.offset.click.left=t.left+this.margins.left),"right"in t&&(this.offset.click.left=this.helperProportions.width-t.right+this.margins.left),"top"in t&&(this.offset.click.top=t.top+this.margins.top),"bottom"in t&&(this.offset.click.top=this.helperProportions.height-t.bottom+this.margins.top)},_getParentOffset:function(){this.offsetParent=this.helper.offsetParent();var t=this.offsetParent.offset();this.cssPosition=="absolute"&&this.scrollParent[0]!=document&&e.ui.contains(this.scrollParent[0],this.offsetParent[0])&&(t.left+=this.scrollParent.scrollLeft(),t.top+=this.scrollParent.scrollTop());if(this.offsetParent[0]==document.body||this.offsetParent[0].tagName&&this.offsetParent[0].tagName.toLowerCase()=="html"&&e.browser.msie)t={top:0,left:0};return{top:t.top+(parseInt(this.offsetParent.css("borderTopWidth"),10)||0),left:t.left+(parseInt(this.offsetParent.css("borderLeftWidth"),10)||0)}},_getRelativeOffset:function(){if(this.cssPosition=="relative"){var e=this.element.position();return{top:e.top-(parseInt(this.helper.css("top"),10)||0)+this.scrollParent.scrollTop(),left:e.left-(parseInt(this.helper.css("left"),10)||0)+this.scrollParent.scrollLeft()}}return{top:0,left:0}},_cacheMargins:function(){this.margins={left:parseInt(this.element.css("marginLeft"),10)||0,top:parseInt(this.element.css("marginTop"),10)||0,right:parseInt(this.element.css("marginRight"),10)||0,bottom:parseInt(this.element.css("marginBottom"),10)||0}},_cacheHelperProportions:function(){this.helperProportions={width:this.helper.outerWidth(),height:this.helper.outerHeight()}},_setContainment:function(){var t=this.options;t.containment=="parent"&&(t.containment=this.helper[0].parentNode);if(t.containment=="document"||t.containment=="window")this.containment=[t.containment=="document"?0:e(window).scrollLeft()-this.offset.relative.left-this.offset.parent.left,t.containment=="document"?0:e(window).scrollTop()-this.offset.relative.top-this.offset.parent.top,(t.containment=="document"?0:e(window).scrollLeft())+e(t.containment=="document"?document:window).width()-this.helperProportions.width-this.margins.left,(t.containment=="document"?0:e(window).scrollTop())+(e(t.containment=="document"?document:window).height()||document.body.parentNode.scrollHeight)-this.helperProportions.height-this.margins.top];if(!/^(document|window|parent)$/.test(t.containment)&&t.containment.constructor!=Array){var n=e(t.containment),r=n[0];if(!r)return;var i=n.offset(),s=e(r).css("overflow")!="hidden";this.containment=[(parseInt(e(r).css("borderLeftWidth"),10)||0)+(parseInt(e(r).css("paddingLeft"),10)||0),(parseInt(e(r).css("borderTopWidth"),10)||0)+(parseInt(e(r).css("paddingTop"),10)||0),(s?Math.max(r.scrollWidth,r.offsetWidth):r.offsetWidth)-(parseInt(e(r).css("borderLeftWidth"),10)||0)-(parseInt(e(r).css("paddingRight"),10)||0)-this.helperProportions.width-this.margins.left-this.margins.right,(s?Math.max(r.scrollHeight,r.offsetHeight):r.offsetHeight)-(parseInt(e(r).css("borderTopWidth"),10)||0)-(parseInt(e(r).css("paddingBottom"),10)||0)-this.helperProportions.height-this.margins.top-this.margins.bottom],this.relative_container=n}else t.containment.constructor==Array&&(this.containment=t.containment)},_convertPositionTo:function(t,n){n||(n=this.position);var r=t=="absolute"?1:-1,i=this.options,s=this.cssPosition!="absolute"||this.scrollParent[0]!=document&&!!e.ui.contains(this.scrollParent[0],this.offsetParent[0])?this.scrollParent:this.offsetParent,o=/(html|body)/i.test(s[0].tagName);return{top:n.top+this.offset.relative.top*r+this.offset.parent.top*r-(e.browser.safari&&e.browser.version<526&&this.cssPosition=="fixed"?0:(this.cssPosition=="fixed"?-this.scrollParent.scrollTop():o?0:s.scrollTop())*r),left:n.left+this.offset.relative.left*r+this.offset.parent.left*r-(e.browser.safari&&e.browser.version<526&&this.cssPosition=="fixed"?0:(this.cssPosition=="fixed"?-this.scrollParent.scrollLeft():o?0:s.scrollLeft())*r)}},_generatePosition:function(t){var n=this.options,r=this.cssPosition!="absolute"||this.scrollParent[0]!=document&&!!e.ui.contains(this.scrollParent[0],this.offsetParent[0])?this.scrollParent:this.offsetParent,i=/(html|body)/i.test(r[0].tagName),s=t.pageX,o=t.pageY;if(this.originalPosition){var u;if(this.containment){if(this.relative_container){var a=this.relative_container.offset();u=[this.containment[0]+a.left,this.containment[1]+a.top,this.containment[2]+a.left,this.containment[3]+a.top]}else u=this.containment;t.pageX-this.offset.click.left<u[0]&&(s=u[0]+this.offset.click.left),t.pageY-this.offset.click.top<u[1]&&(o=u[1]+this.offset.click.top),t.pageX-this.offset.click.left>u[2]&&(s=u[2]+this.offset.click.left),t.pageY-this.offset.click.top>u[3]&&(o=u[3]+this.offset.click.top)}if(n.grid){var f=n.grid[1]?this.originalPageY+Math.round((o-this.originalPageY)/n.grid[1])*n.grid[1]:this.originalPageY;o=u?f-this.offset.click.top<u[1]||f-this.offset.click.top>u[3]?f-this.offset.click.top<u[1]?f+n.grid[1]:f-n.grid[1]:f:f;var l=n.grid[0]?this.originalPageX+Math.round((s-this.originalPageX)/n.grid[0])*n.grid[0]:this.originalPageX;s=u?l-this.offset.click.left<u[0]||l-this.offset.click.left>u[2]?l-this.offset.click.left<u[0]?l+n.grid[0]:l-n.grid[0]:l:l}}return{top:o-this.offset.click.top-this.offset.relative.top-this.offset.parent.top+(e.browser.safari&&e.browser.version<526&&this.cssPosition=="fixed"?0:this.cssPosition=="fixed"?-this.scrollParent.scrollTop():i?0:r.scrollTop()),left:s-this.offset.click.left-this.offset.relative.left-this.offset.parent.left+(e.browser.safari&&e.browser.version<526&&this.cssPosition=="fixed"?0:this.cssPosition=="fixed"?-this.scrollParent.scrollLeft():i?0:r.scrollLeft())}},_clear:function(){this.helper.removeClass("ui-draggable-dragging"),this.helper[0]!=this.element[0]&&!this.cancelHelperRemoval&&this.helper.remove(),this.helper=null,this.cancelHelperRemoval=!1},_trigger:function(t,n,r){return r=r||this._uiHash(),e.ui.plugin.call(this,t,[n,r]),t=="drag"&&(this.positionAbs=this._convertPositionTo("absolute")),e.Widget.prototype._trigger.call(this,t,n,r)},plugins:{},_uiHash:function(e){return{helper:this.helper,position:this.position,originalPosition:this.originalPosition,offset:this.positionAbs}}}),e.extend(e.ui.draggable,{version:"@VERSION"}),e.ui.plugin.add("draggable","connectToSortable",{start:function(t,n){var r=e(this).data("draggable"),i=r.options,s=e.extend({},n,{item:r.element});r.sortables=[],e(i.connectToSortable).each(function(){var n=e.data(this,"sortable");n&&!n.options.disabled&&(r.sortables.push({instance:n,shouldRevert:n.options.revert}),n.refreshPositions(),n._trigger("activate",t,s))})},stop:function(t,n){var r=e(this).data("draggable"),i=e.extend({},n,{item:r.element});e.each(r.sortables,function(){this.instance.isOver?(this.instance.isOver=0,r.cancelHelperRemoval=!0,this.instance.cancelHelperRemoval=!1,this.shouldRevert&&(this.instance.options.revert=!0),this.instance._mouseStop(t),this.instance.options.helper=this.instance.options._helper,r.options.helper=="original"&&this.instance.currentItem.css({top:"auto",left:"auto"})):(this.instance.cancelHelperRemoval=!1,this.instance._trigger("deactivate",t,i))})},drag:function(t,n){var r=e(this).data("draggable"),i=this,s=function(t){var n=this.offset.click.top,r=this.offset.click.left,i=this.positionAbs.top,s=this.positionAbs.left,o=t.height,u=t.width,a=t.top,f=t.left;return e.ui.isOver(i+n,s+r,a,f,o,u)};e.each(r.sortables,function(s){this.instance.positionAbs=r.positionAbs,this.instance.helperProportions=r.helperProportions,this.instance.offset.click=r.offset.click,this.instance._intersectsWith(this.instance.containerCache)?(this.instance.isOver||(this.instance.isOver=1,this.instance.currentItem=e(i).clone().removeAttr("id").appendTo(this.instance.element).data("sortable-item",!0),this.instance.options._helper=this.instance.options.helper,this.instance.options.helper=function(){return n.helper[0]},t.target=this.instance.currentItem[0],this.instance._mouseCapture(t,!0),this.instance._mouseStart(t,!0,!0),this.instance.offset.click.top=r.offset.click.top,this.instance.offset.click.left=r.offset.click.left,this.instance.offset.parent.left-=r.offset.parent.left-this.instance.offset.parent.left,this.instance.offset.parent.top-=r.offset.parent.top-this.instance.offset.parent.top,r._trigger("toSortable",t),r.dropped=this.instance.element,r.currentItem=r.element,this.instance.fromOutside=r),this.instance.currentItem&&this.instance._mouseDrag(t)):this.instance.isOver&&(this.instance.isOver=0,this.instance.cancelHelperRemoval=!0,this.instance.options.revert=!1,this.instance._trigger("out",t,this.instance._uiHash(this.instance)),this.instance._mouseStop(t,!0),this.instance.options.helper=this.instance.options._helper,this.instance.currentItem.remove(),this.instance.placeholder&&this.instance.placeholder.remove(),r._trigger("fromSortable",t),r.dropped=!1)})}}),e.ui.plugin.add("draggable","cursor",{start:function(t,n){var r=e("body"),i=e(this).data("draggable").options;r.css("cursor")&&(i._cursor=r.css("cursor")),r.css("cursor",i.cursor)},stop:function(t,n){var r=e(this).data("draggable").options;r._cursor&&e("body").css("cursor",r._cursor)}}),e.ui.plugin.add("draggable","opacity",{start:function(t,n){var r=e(n.helper),i=e(this).data("draggable").options;r.css("opacity")&&(i._opacity=r.css("opacity")),r.css("opacity",i.opacity)},stop:function(t,n){var r=e(this).data("draggable").options;r._opacity&&e(n.helper).css("opacity",r._opacity)}}),e.ui.plugin.add("draggable","scroll",{start:function(t,n){var r=e(this).data("draggable");r.scrollParent[0]!=document&&r.scrollParent[0].tagName!="HTML"&&(r.overflowOffset=r.scrollParent.offset())},drag:function(t,n){var r=e(this).data("draggable"),i=r.options,s=!1;if(r.scrollParent[0]!=document&&r.scrollParent[0].tagName!="HTML"){if(!i.axis||i.axis!="x")r.overflowOffset.top+r.scrollParent[0].offsetHeight-t.pageY<i.scrollSensitivity?r.scrollParent[0].scrollTop=s=r.scrollParent[0].scrollTop+i.scrollSpeed:t.pageY-r.overflowOffset.top<i.scrollSensitivity&&(r.scrollParent[0].scrollTop=s=r.scrollParent[0].scrollTop-i.scrollSpeed);if(!i.axis||i.axis!="y")r.overflowOffset.left+r.scrollParent[0].offsetWidth-t.pageX<i.scrollSensitivity?r.scrollParent[0].scrollLeft=s=r.scrollParent[0].scrollLeft+i.scrollSpeed:t.pageX-r.overflowOffset.left<i.scrollSensitivity&&(r.scrollParent[0].scrollLeft=s=r.scrollParent[0].scrollLeft-i.scrollSpeed)}else{if(!i.axis||i.axis!="x")t.pageY-e(document).scrollTop()<i.scrollSensitivity?s=e(document).scrollTop(e(document).scrollTop()-i.scrollSpeed):e(window).height()-(t.pageY-e(document).scrollTop())<i.scrollSensitivity&&(s=e(document).scrollTop(e(document).scrollTop()+i.scrollSpeed));if(!i.axis||i.axis!="y")t.pageX-e(document).scrollLeft()<i.scrollSensitivity?s=e(document).scrollLeft(e(document).scrollLeft()-i.scrollSpeed):e(window).width()-(t.pageX-e(document).scrollLeft())<i.scrollSensitivity&&(s=e(document).scrollLeft(e(document).scrollLeft()+i.scrollSpeed))}s!==!1&&e.ui.ddmanager&&!i.dropBehaviour&&e.ui.ddmanager.prepareOffsets(r,t)}}),e.ui.plugin.add("draggable","snap",{start:function(t,n){var r=e(this).data("draggable"),i=r.options;r.snapElements=[],e(i.snap.constructor!=String?i.snap.items||":data(draggable)":i.snap).each(function(){var t=e(this),n=t.offset();this!=r.element[0]&&r.snapElements.push({item:this,width:t.outerWidth(),height:t.outerHeight(),top:n.top,left:n.left})})},drag:function(t,n){var r=e(this).data("draggable"),i=r.options,s=i.snapTolerance,o=n.offset.left,u=o+r.helperProportions.width,a=n.offset.top,f=a+r.helperProportions.height;for(var l=r.snapElements.length-1;l>=0;l--){var c=r.snapElements[l].left,h=c+r.snapElements[l].width,p=r.snapElements[l].top,d=p+r.snapElements[l].height;if(!(c-s<o&&o<h+s&&p-s<a&&a<d+s||c-s<o&&o<h+s&&p-s<f&&f<d+s||c-s<u&&u<h+s&&p-s<a&&a<d+s||c-s<u&&u<h+s&&p-s<f&&f<d+s)){r.snapElements[l].snapping&&r.options.snap.release&&r.options.snap.release.call(r.element,t,e.extend(r._uiHash(),{snapItem:r.snapElements[l].item})),r.snapElements[l].snapping=!1;continue}if(i.snapMode!="inner"){var v=Math.abs(p-f)<=s,m=Math.abs(d-a)<=s,g=Math.abs(c-u)<=s,y=Math.abs(h-o)<=s;v&&(n.position.top=r._convertPositionTo("relative",{top:p-r.helperProportions.height,left:0}).top-r.margins.top),m&&(n.position.top=r._convertPositionTo("relative",{top:d,left:0}).top-r.margins.top),g&&(n.position.left=r._convertPositionTo("relative",{top:0,left:c-r.helperProportions.width}).left-r.margins.left),y&&(n.position.left=r._convertPositionTo("relative",{top:0,left:h}).left-r.margins.left)}var b=v||m||g||y;if(i.snapMode!="outer"){var v=Math.abs(p-a)<=s,m=Math.abs(d-f)<=s,g=Math.abs(c-o)<=s,y=Math.abs(h-u)<=s;v&&(n.position.top=r._convertPositionTo("relative",{top:p,left:0}).top-r.margins.top),m&&(n.position.top=r._convertPositionTo("relative",{top:d-r.helperProportions.height,left:0}).top-r.margins.top),g&&(n.position.left=r._convertPositionTo("relative",{top:0,left:c}).left-r.margins.left),y&&(n.position.left=r._convertPositionTo("relative",{top:0,left:h-r.helperProportions.width}).left-r.margins.left)}!r.snapElements[l].snapping&&(v||m||g||y||b)&&r.options.snap.snap&&r.options.snap.snap.call(r.element,t,e.extend(r._uiHash(),{snapItem:r.snapElements[l].item})),r.snapElements[l].snapping=v||m||g||y||b}}}),e.ui.plugin.add("draggable","stack",{start:function(t,n){var r=e(this).data("draggable").options,i=e.makeArray(e(r.stack)).sort(function(t,n){return(parseInt(e(t).css("zIndex"),10)||0)-(parseInt(e(n).css("zIndex"),10)||0)});if(!i.length)return;var s=parseInt(i[0].style.zIndex)||0;e(i).each(function(e){this.style.zIndex=s+e}),this[0].style.zIndex=s+i.length}}),e.ui.plugin.add("draggable","zIndex",{start:function(t,n){var r=e(n.helper),i=e(this).data("draggable").options;r.css("zIndex")&&(i._zIndex=r.css("zIndex")),r.css("zIndex",i.zIndex)},stop:function(t,n){var r=e(this).data("draggable").options;r._zIndex&&e(n.helper).css("zIndex",r._zIndex)}})}(jQuery),function(e,t){e.widget("ui.droppable",{widgetEventPrefix:"drop",options:{accept:"*",activeClass:!1,addClasses:!0,greedy:!1,hoverClass:!1,scope:"default",tolerance:"intersect"},_create:function(){var t=this.options,n=t.accept;this.isover=0,this.isout=1,this.accept=e.isFunction(n)?n:function(e){return e.is(n)},this.proportions={width:this.element[0].offsetWidth,height:this.element[0].offsetHeight},e.ui.ddmanager.droppables[t.scope]=e.ui.ddmanager.droppables[t.scope]||[],e.ui.ddmanager.droppables[t.scope].push(this),t.addClasses&&this.element.addClass("ui-droppable")},destroy:function(){var t=e.ui.ddmanager.droppables[this.options.scope];for(var n=0;n<t.length;n++)t[n]==this&&t.splice(n,1);return this.element.removeClass("ui-droppable ui-droppable-disabled").removeData("droppable").unbind(".droppable"),this},_setOption:function(t,n){t=="accept"&&(this.accept=e.isFunction(n)?n:function(e){return e.is(n)}),e.Widget.prototype._setOption.apply(this,arguments)},_activate:function(t){var n=e.ui.ddmanager.current;this.options.activeClass&&this.element.addClass(this.options.activeClass),n&&this._trigger("activate",t,this.ui(n))},_deactivate:function(t){var n=e.ui.ddmanager.current;this.options.activeClass&&this.element.removeClass(this.options.activeClass),n&&this._trigger("deactivate",t,this.ui(n))},_over:function(t){var n=e.ui.ddmanager.current;if(!n||(n.currentItem||n.element)[0]==this.element[0])return;this.accept.call(this.element[0],n.currentItem||n.element)&&(this.options.hoverClass&&this.element.addClass(this.options.hoverClass),this._trigger("over",t,this.ui(n)))},_out:function(t){var n=e.ui.ddmanager.current;if(!n||(n.currentItem||n.element)[0]==this.element[0])return;this.accept.call(this.element[0],n.currentItem||n.element)&&(this.options.hoverClass&&this.element.removeClass(this.options.hoverClass),this._trigger("out",t,this.ui(n)))},_drop:function(t,n){var r=n||e.ui.ddmanager.current;if(!r||(r.currentItem||r.element)[0]==this.element[0])return!1;var i=!1;return this.element.find(":data(droppable)").not(".ui-draggable-dragging").each(function(){var t=e.data(this,"droppable");if(t.options.greedy&&!t.options.disabled&&t.options.scope==r.options.scope&&t.accept.call(t.element[0],r.currentItem||r.element)&&e.ui.intersect(r,e.extend(t,{offset:t.element.offset()}),t.options.tolerance))return i=!0,!1}),i?!1:this.accept.call(this.element[0],r.currentItem||r.element)?(this.options.activeClass&&this.element.removeClass(this.options.activeClass),this.options.hoverClass&&this.element.removeClass(this.options.hoverClass),this._trigger("drop",t,this.ui(r)),this.element):!1},ui:function(e){return{draggable:e.currentItem||e.element,helper:e.helper,position:e.position,offset:e.positionAbs}}}),e.extend(e.ui.droppable,{version:"@VERSION"}),e.ui.intersect=function(t,n,r){if(!n.offset)return!1;var i=(t.positionAbs||t.position.absolute).left,s=i+t.helperProportions.width,o=(t.positionAbs||t.position.absolute).top,u=o+t.helperProportions.height,a=n.offset.left,f=a+n.proportions.width,l=n.offset.top,c=l+n.proportions.height;switch(r){case"fit":return a<=i&&s<=f&&l<=o&&u<=c;case"intersect":return a<i+t.helperProportions.width/2&&s-t.helperProportions.width/2<f&&l<o+t.helperProportions.height/2&&u-t.helperProportions.height/2<c;case"pointer":var h=(t.positionAbs||t.position.absolute).left+(t.clickOffset||t.offset.click).left,p=(t.positionAbs||t.position.absolute).top+(t.clickOffset||t.offset.click).top,d=e.ui.isOver(p,h,l,a,n.proportions.height,n.proportions.width);return d;case"touch":return(o>=l&&o<=c||u>=l&&u<=c||o<l&&u>c)&&(i>=a&&i<=f||s>=a&&s<=f||i<a&&s>f);default:return!1}},e.ui.ddmanager={current:null,droppables:{"default":[]},prepareOffsets:function(t,n){var r=e.ui.ddmanager.droppables[t.options.scope]||[],i=n?n.type:null,s=(t.currentItem||t.element).find(":data(droppable)").andSelf();e:for(var o=0;o<r.length;o++){if(r[o].options.disabled||t&&!r[o].accept.call(r[o].element[0],t.currentItem||t.element))continue;for(var u=0;u<s.length;u++)if(s[u]==r[o].element[0]){r[o].proportions.height=0;continue e}r[o].visible=r[o].element.css("display")!="none";if(!r[o].visible)continue;i=="mousedown"&&r[o]._activate.call(r[o],n),r[o].offset=r[o].element.offset(),r[o].proportions={width:r[o].element[0].offsetWidth,height:r[o].element[0].offsetHeight}}},drop:function(t,n){var r=!1;return e.each(e.ui.ddmanager.droppables[t.options.scope]||[],function(){if(!this.options)return;!this.options.disabled&&this.visible&&e.ui.intersect(t,this,this.options.tolerance)&&(r=this._drop.call(this,n)||r),!this.options.disabled&&this.visible&&this.accept.call(this.element[0],t.currentItem||t.element)&&(this.isout=1,this.isover=0,this._deactivate.call(this,n))}),r},dragStart:function(t,n){t.element.parents(":not(body,html)").bind("scroll.droppable",function(){t.options.refreshPositions||e.ui.ddmanager.prepareOffsets(t,n)})},drag:function(t,n){t.options.refreshPositions&&e.ui.ddmanager.prepareOffsets(t,n),e.each(e.ui.ddmanager.droppables[t.options.scope]||[],function(){if(this.options.disabled||this.greedyChild||!this.visible)return;var r=e.ui.intersect(t,this,this.options.tolerance),i=!r&&this.isover==1?"isout":r&&this.isover==0?"isover":null;if(!i)return;var s;if(this.options.greedy){var o=this.element.parents(":data(droppable):eq(0)");o.length&&(s=e.data(o[0],"droppable"),s.greedyChild=i=="isover"?1:0)}s&&i=="isover"&&(s.isover=0,s.isout=1,s._out.call(s,n)),this[i]=1,this[i=="isout"?"isover":"isout"]=0,this[i=="isover"?"_over":"_out"].call(this,n),s&&i=="isout"&&(s.isout=0,s.isover=1,s._over.call(s,n))})},dragStop:function(t,n){t.element.parents(":not(body,html)").unbind("scroll.droppable"),t.options.refreshPositions||e.ui.ddmanager.prepareOffsets(t,n)}}}(jQuery),function(e,t){e.widget("ui.resizable",e.ui.mouse,{widgetEventPrefix:"resize",options:{alsoResize:!1,animate:!1,animateDuration:"slow",animateEasing:"swing",aspectRatio:!1,autoHide:!1,containment:!1,ghost:!1,grid:!1,handles:"e,s,se",helper:!1,maxHeight:null,maxWidth:null,minHeight:10,minWidth:10,zIndex:1e3},_create:function(){var t=this,n=this.options;this.element.addClass("ui-resizable"),e.extend(this,{_aspectRatio:!!n.aspectRatio,aspectRatio:n.aspectRatio,originalElement:this.element,_proportionallyResizeElements:[],_helper:n.helper||n.ghost||n.animate?n.helper||"ui-resizable-helper":null}),this.element[0].nodeName.match(/canvas|textarea|input|select|button|img/i)&&(this.element.wrap(e('<div class="ui-wrapper" style="overflow: hidden;"></div>').css({position:this.element.css("position"),width:this.element.outerWidth(),height:this.element.outerHeight(),top:this.element.css("top"),left:this.element.css("left")})),this.element=this.element.parent().data("resizable",this.element.data("resizable")),this.elementIsWrapper=!0,this.element.css({marginLeft:this.originalElement.css("marginLeft"),marginTop:this.originalElement.css("marginTop"),marginRight:this.originalElement.css("marginRight"),marginBottom:this.originalElement.css("marginBottom")}),this.originalElement.css({marginLeft:0,marginTop:0,marginRight:0,marginBottom:0}),this.originalResizeStyle=this.originalElement.css("resize"),this.originalElement.css("resize","none"),this._proportionallyResizeElements.push(this.originalElement.css({position:"static",zoom:1,display:"block"})),this.originalElement.css({margin:this.originalElement.css("margin")}),this._proportionallyResize()),this.handles=n.handles||(e(".ui-resizable-handle",this.element).length?{n:".ui-resizable-n",e:".ui-resizable-e",s:".ui-resizable-s",w:".ui-resizable-w",se:".ui-resizable-se",sw:".ui-resizable-sw",ne:".ui-resizable-ne",nw:".ui-resizable-nw"}:"e,s,se");if(this.handles.constructor==String){this.handles=="all"&&(this.handles="n,e,s,w,se,sw,ne,nw");var r=this.handles.split(",");this.handles={};for(var i=0;i<r.length;i++){var s=e.trim(r[i]),o="ui-resizable-"+s,u=e('<div class="ui-resizable-handle '+o+'"></div>');/sw|se|ne|nw/.test(s)&&u.css({zIndex:++n.zIndex}),"se"==s&&u.addClass("ui-icon ui-icon-gripsmall-diagonal-se"),this.handles[s]=".ui-resizable-"+s,this.element.append(u)}}this._renderAxis=function(t){t=t||this.element;for(var n in this.handles){this.handles[n].constructor==String&&(this.handles[n]=e(this.handles[n],this.element).show());if(this.elementIsWrapper&&this.originalElement[0].nodeName.match(/textarea|input|select|button/i)){var r=e(this.handles[n],this.element),i=0;i=/sw|ne|nw|se|n|s/.test(n)?r.outerHeight():r.outerWidth();var s=["padding",/ne|nw|n/.test(n)?"Top":/se|sw|s/.test(n)?"Bottom":/^e$/.test(n)?"Right":"Left"].join("");t.css(s,i),this._proportionallyResize()}if(!e(this.handles[n]).length)continue}},this._renderAxis(this.element),this._handles=e(".ui-resizable-handle",this.element).disableSelection(),this._handles.mouseover(function(){if(!t.resizing){if(this.className)var e=this.className.match(/ui-resizable-(se|sw|ne|nw|n|e|s|w)/i);t.axis=e&&e[1]?e[1]:"se"}}),n.autoHide&&(this._handles.hide(),e(this.element).addClass("ui-resizable-autohide").hover(function(){if(n.disabled)return;e(this).removeClass("ui-resizable-autohide"),t._handles.show()},function(){if(n.disabled)return;t.resizing||(e(this).addClass("ui-resizable-autohide"),t._handles.hide())})),this._mouseInit()},destroy:function(){this._mouseDestroy();var t=function(t){e(t).removeClass("ui-resizable ui-resizable-disabled ui-resizable-resizing").removeData("resizable").unbind(".resizable").find(".ui-resizable-handle").remove()};if(this.elementIsWrapper){t(this.element);var n=this.element;n.after(this.originalElement.css({position:n.css("position"),width:n.outerWidth(),height:n.outerHeight(),top:n.css("top"),left:n.css("left")})).remove()}return this.originalElement.css("resize",this.originalResizeStyle),t(this.originalElement),this},_mouseCapture:function(t){var n=!1;for(var r in this.handles)e(this.handles[r])[0]==t.target&&(n=!0);return!this.options.disabled&&n},_mouseStart:function(t){var r=this.options,i=this.element.position(),s=this.element;this.resizing=!0,this.documentScroll={top:e(document).scrollTop(),left:e(document).scrollLeft()},(s.is(".ui-draggable")||/absolute/.test(s.css("position")))&&s.css({position:"absolute",top:i.top,left:i.left}),this._renderProxy();var o=n(this.helper.css("left")),u=n(this.helper.css("top"));r.containment&&(o+=e(r.containment).scrollLeft()||0,u+=e(r.containment).scrollTop()||0),this.offset=this.helper.offset(),this.position={left:o,top:u},this.size=this._helper?{width:s.outerWidth(),height:s.outerHeight()}:{width:s.width(),height:s.height()},this.originalSize=this._helper?{width:s.outerWidth(),height:s.outerHeight()}:{width:s.width(),height:s.height()},this.originalPosition={left:o,top:u},this.sizeDiff={width:s.outerWidth()-s.width(),height:s.outerHeight()-s.height()},this.originalMousePosition={left:t.pageX,top:t.pageY},this.aspectRatio=typeof r.aspectRatio=="number"?r.aspectRatio:this.originalSize.width/this.originalSize.height||1;var a=e(".ui-resizable-"+this.axis).css("cursor");return e("body").css("cursor",a=="auto"?this.axis+"-resize":a),s.addClass("ui-resizable-resizing"),this._propagate("start",t),!0},_mouseDrag:function(t){var n=this.helper,r=this.options,i={},s=this,o=this.originalMousePosition,u=this.axis,a=t.pageX-o.left||0,f=t.pageY-o.top||0,l=this._change[u];if(!l)return!1;var c=l.apply(this,[t,a,f]),h=e.browser.msie&&e.browser.version<7,p=this.sizeDiff;this._updateVirtualBoundaries(t.shiftKey);if(this._aspectRatio||t.shiftKey)c=this._updateRatio(c,t);return c=this._respectSize(c,t),this._propagate("resize",t),n.css({top:this.position.top+"px",left:this.position.left+"px",width:this.size.width+"px",height:this.size.height+"px"}),!this._helper&&this._proportionallyResizeElements.length&&this._proportionallyResize(),this._updateCache(c),this._trigger("resize",t,this.ui()),!1},_mouseStop:function(t){this.resizing=!1;var n=this.options,r=this;if(this._helper){var i=this._proportionallyResizeElements,s=i.length&&/textarea/i.test(i[0].nodeName),o=s&&e.ui.hasScroll(i[0],"left")?0:r.sizeDiff.height,u=s?0:r.sizeDiff.width,a={width:r.helper.width()-u,height:r.helper.height()-o},f=parseInt(r.element.css("left"),10)+(r.position.left-r.originalPosition.left)||null,l=parseInt(r.element.css("top"),10)+(r.position.top-r.originalPosition.top)||null;n.animate||this.element.css(e.extend(a,{top:l,left:f})),r.helper.height(r.size.height),r.helper.width(r.size.width),this._helper&&!n.animate&&this._proportionallyResize()}return e("body").css("cursor","auto"),this.element.removeClass("ui-resizable-resizing"),this._propagate("stop",t),this._helper&&this.helper.remove(),!1},_updateVirtualBoundaries:function(e){var t=this.options,n,i,s,o,u;u={minWidth:r(t.minWidth)?t.minWidth:0,maxWidth:r(t.maxWidth)?t.maxWidth:Infinity,minHeight:r(t.minHeight)?t.minHeight:0,maxHeight:r(t.maxHeight)?t.maxHeight:Infinity};if(this._aspectRatio||e)n=u.minHeight*this.aspectRatio,s=u.minWidth/this.aspectRatio,i=u.maxHeight*this.aspectRatio,o=u.maxWidth/this.aspectRatio,n>u.minWidth&&(u.minWidth=n),s>u.minHeight&&(u.minHeight=s),i<u.maxWidth&&(u.maxWidth=i),o<u.maxHeight&&(u.maxHeight=o);this._vBoundaries=u},_updateCache:function(e){var t=this.options;this.offset=this.helper.offset(),r(e.left)&&(this.position.left=e.left),r(e.top)&&(this.position.top=e.top),r(e.height)&&(this.size.height=e.height),r(e.width)&&(this.size.width=e.width)},_updateRatio:function(e,t){var n=this.options,i=this.position,s=this.size,o=this.axis;return r(e.height)?e.width=e.height*this.aspectRatio:r(e.width)&&(e.height=e.width/this.aspectRatio),o=="sw"&&(e.left=i.left+(s.width-e.width),e.top=null),o=="nw"&&(e.top=i.top+(s.height-e.height),e.left=i.left+(s.width-e.width)),e},_respectSize:function(e,t){var n=this.helper,i=this._vBoundaries,s=this._aspectRatio||t.shiftKey,o=this.axis,u=r(e.width)&&i.maxWidth&&i.maxWidth<e.width,a=r(e.height)&&i.maxHeight&&i.maxHeight<e.height,f=r(e.width)&&i.minWidth&&i.minWidth>e.width,l=r(e.height)&&i.minHeight&&i.minHeight>e.height;f&&(e.width=i.minWidth),l&&(e.height=i.minHeight),u&&(e.width=i.maxWidth),a&&(e.height=i.maxHeight);var c=this.originalPosition.left+this.originalSize.width,h=this.position.top+this.size.height,p=/sw|nw|w/.test(o),d=/nw|ne|n/.test(o);f&&p&&(e.left=c-i.minWidth),u&&p&&(e.left=c-i.maxWidth),l&&d&&(e.top=h-i.minHeight),a&&d&&(e.top=h-i.maxHeight);var v=!e.width&&!e.height;return v&&!e.left&&e.top?e.top=null:v&&!e.top&&e.left&&(e.left=null),e},_proportionallyResize:function(){var t=this.options;if(!this._proportionallyResizeElements.length)return;var n=this.helper||this.element;for(var r=0;r<this._proportionallyResizeElements.length;r++){var i=this._proportionallyResizeElements[r];if(!this.borderDif){var s=[i.css("borderTopWidth"),i.css("borderRightWidth"),i.css("borderBottomWidth"),i.css("borderLeftWidth")],o=[i.css("paddingTop"),i.css("paddingRight"),i.css("paddingBottom"),i.css("paddingLeft")];this.borderDif=e.map(s,function(e,t){var n=parseInt(e,10)||0,r=parseInt(o[t],10)||0;return n+r})}if(!(!e.browser.msie||!e(n).is(":hidden")&&!e(n).parents(":hidden").length))continue;i.css({height:n.height()-this.borderDif[0]-this.borderDif[2]||0,width:n.width()-this.borderDif[1]-this.borderDif[3]||0})}},_renderProxy:function(){var t=this.element,n=this.options;this.elementOffset=t.offset();if(this._helper){this.helper=this.helper||e('<div style="overflow:hidden;"></div>');var r=e.browser.msie&&e.browser.version<7,i=r?1:0,s=r?2:-1;this.helper.addClass(this._helper).css({width:this.element.outerWidth()+s,height:this.element.outerHeight()+s,position:"absolute",left:this.elementOffset.left-i+"px",top:this.elementOffset.top-i+"px",zIndex:++n.zIndex}),this.helper.appendTo("body").disableSelection()}else this.helper=this.element},_change:{e:function(e,t,n){return{width:this.originalSize.width+t}},w:function(e,t,n){var r=this.options,i=this.originalSize,s=this.originalPosition;return{left:s.left+t,width:i.width-t}},n:function(e,t,n){var r=this.options,i=this.originalSize,s=this.originalPosition;return{top:s.top+n,height:i.height-n}},s:function(e,t,n){return{height:this.originalSize.height+n}},se:function(t,n,r){return e.extend(this._change.s.apply(this,arguments),this._change.e.apply(this,[t,n,r]))},sw:function(t,n,r){return e.extend(this._change.s.apply(this,arguments),this._change.w.apply(this,[t,n,r]))},ne:function(t,n,r){return e.extend(this._change.n.apply(this,arguments),this._change.e.apply(this,[t,n,r]))},nw:function(t,n,r){return e.extend(this._change.n.apply(this,arguments),this._change.w.apply(this,[t,n,r]))}},_propagate:function(t,n){e.ui.plugin.call(this,t,[n,this.ui()]),t!="resize"&&this._trigger(t,n,this.ui())},plugins:{},ui:function(){return{originalElement:this.originalElement,element:this.element,helper:this.helper,position:this.position,size:this.size,originalSize:this.originalSize,originalPosition:this.originalPosition}}}),e.extend(e.ui.resizable,{version:"@VERSION"}),e.ui.plugin.add("resizable","alsoResize",{start:function(t,n){var r=e(this).data("resizable"),i=r.options,s=function(t){e(t).each(function(){var t=e(this);t.data("resizable-alsoresize",{width:parseInt(t.width(),10),height:parseInt(t.height(),10),left:parseInt(t.css("left"),10),top:parseInt(t.css("top"),10)})})};typeof i.alsoResize=="object"&&!i.alsoResize.parentNode?i.alsoResize.length?(i.alsoResize=i.alsoResize[0],s(i.alsoResize)):e.each(i.alsoResize,function(e){s(e)}):s(i.alsoResize)},resize:function(t,n){var r=e(this).data("resizable"),i=r.options,s=r.originalSize,o=r.originalPosition,u={height:r.size.height-s.height||0,width:r.size.width-s.width||0,top:r.position.top-o.top||0,left:r.position.left-o.left||0},a=function(t,r){e(t).each(function(){var t=e(this),i=e(this).data("resizable-alsoresize"),s={},o=r&&r.length?r:t.parents(n.originalElement[0]).length?["width","height"]:["width","height","top","left"];e.each(o,function(e,t){var n=(i[t]||0)+(u[t]||0);n&&n>=0&&(s[t]=n||null)}),t.css(s)})};typeof i.alsoResize=="object"&&!i.alsoResize.nodeType?e.each(i.alsoResize,function(e,t){a(e,t)}):a(i.alsoResize)},stop:function(t,n){e(this).removeData("resizable-alsoresize")}}),e.ui.plugin.add("resizable","animate",{stop:function(t,n){var r=e(this).data("resizable"),i=r.options,s=r._proportionallyResizeElements,o=s.length&&/textarea/i.test(s[0].nodeName),u=o&&e.ui.hasScroll(s[0],"left")?0:r.sizeDiff.height,a=o?0:r.sizeDiff.width,f={width:r.size.width-a,height:r.size.height-u},l=parseInt(r.element.css("left"),10)+(r.position.left-r.originalPosition.left)||null,c=parseInt(r.element.css("top"),10)+(r.position.top-r.originalPosition.top)||null;r.element.animate(e.extend(f,c&&l?{top:c,left:l}:{}),{duration:i.animateDuration,easing:i.animateEasing,step:function(){var n={width:parseInt(r.element.css("width"),10),height:parseInt(r.element.css("height"),10),top:parseInt(r.element.css("top"),10),left:parseInt(r.element.css("left"),10)};s&&s.length&&e(s[0]).css({width:n.width,height:n.height}),r._updateCache(n),r._propagate("resize",t)}})}}),e.ui.plugin.add("resizable","containment",{start:function(t,r){var i=e(this).data("resizable"),s=i.options,o=i.element,u=s.containment,a=u instanceof e?u.get(0):/parent/.test(u)?o.parent().get(0):u;if(!a)return;i.containerElement=e(a);if(/document/.test(u)||u==document)i.containerOffset={left:0,top:0},i.containerPosition={left:0,top:0},i.parentData={element:e(document),left:0,top:0,width:e(document).width(),height:e(document).height()||document.body.parentNode.scrollHeight};else{var f=e(a),l=[];e(["Top","Right","Left","Bottom"]).each(function(e,t){l[e]=n(f.css("padding"+t))}),i.containerOffset=f.offset(),i.containerPosition=f.position(),i.containerSize={height:f.innerHeight()-l[3],width:f.innerWidth()-l[1]};var c=i.containerOffset,h=i.containerSize.height,p=i.containerSize.width,d=e.ui.hasScroll(a,"left")?a.scrollWidth:p,v=e.ui.hasScroll(a)?a.scrollHeight:h;i.parentData={element:a,left:c.left,top:c.top,width:d,height:v}}},resize:function(t,n){var r=e(this).data("resizable"),i=r.options,s=r.containerSize,o=r.containerOffset,u=r.size,a=r.position,f=r._aspectRatio||t.shiftKey,l={top:0,left:0},c=r.containerElement;c[0]!=document&&/static/.test(c.css("position"))&&(l=o),a.left<(r._helper?o.left:0)&&(r.size.width=r.size.width+(r._helper?r.position.left-o.left:r.position.left-l.left),f&&(r.size.height=r.size.width/r.aspectRatio),r.position.left=i.helper?o.left:0),a.top<(r._helper?o.top:0)&&(r.size.height=r.size.height+(r._helper?r.position.top-o.top:r.position.top),f&&(r.size.width=r.size.height*r.aspectRatio),r.position.top=r._helper?o.top:0),r.offset.left=r.parentData.left+r.position.left,r.offset.top=r.parentData.top+r.position.top;var h=Math.abs((r._helper?r.offset.left-l.left:r.offset.left-l.left)+r.sizeDiff.width),p=Math.abs((r._helper?r.offset.top-l.top:r.offset.top-o.top)+r.sizeDiff.height),d=r.containerElement.get(0)==r.element.parent().get(0),v=/relative|absolute/.test(r.containerElement.css("position"));d&&v&&(h-=r.parentData.left),h+r.size.width>=r.parentData.width&&(r.size.width=r.parentData.width-h,f&&(r.size.height=r.size.width/r.aspectRatio)),p+r.size.height>=r.parentData.height&&(r.size.height=r.parentData.height-p,f&&(r.size.width=r.size.height*r.aspectRatio))},stop:function(t,n){var r=e(this).data("resizable"),i=r.options,s=r.position,o=r.containerOffset,u=r.containerPosition,a=r.containerElement,f=e(r.helper),l=f.offset(),c=f.outerWidth()-r.sizeDiff.width,h=f.outerHeight()-r.sizeDiff.height;r._helper&&!i.animate&&/relative/.test(a.css("position"))&&e(this).css({left:l.left-u.left-o.left,width:c,height:h}),r._helper&&!i.animate&&/static/.test(a.css("position"))&&e(this).css({left:l.left-u.left-o.left,width:c,height:h})}}),e.ui.plugin.add("resizable","ghost",{start:function(t,n){var r=e(this).data("resizable"),i=r.options,s=r.size;r.ghost=r.originalElement.clone(),r.ghost.css({opacity:.25,display:"block",position:"relative",height:s.height,width:s.width,margin:0,left:0,top:0}).addClass("ui-resizable-ghost").addClass(typeof i.ghost=="string"?i.ghost:""),r.ghost.appendTo(r.helper)},resize:function(t,n){var r=e(this).data("resizable"),i=r.options;r.ghost&&r.ghost.css({position:"relative",height:r.size.height,width:r.size.width})},stop:function(t,n){var r=e(this).data("resizable"),i=r.options;r.ghost&&r.helper&&r.helper.get(0).removeChild(r.ghost.get(0))}}),e.ui.plugin.add("resizable","grid",{resize:function(t,n){var r=e(this).data("resizable"),i=r.options,s=r.size,o=r.originalSize,u=r.originalPosition,a=r.axis,f=i._aspectRatio||t.shiftKey;i.grid=typeof i.grid=="number"?[i.grid,i.grid]:i.grid;var l=Math.round((s.width-o.width)/(i.grid[0]||1))*(i.grid[0]||1),c=Math.round((s.height-o.height)/(i.grid[1]||1))*(i.grid[1]||1);/^(se|s|e)$/.test(a)?(r.size.width=o.width+l,r.size.height=o.height+c):/^(ne)$/.test(a)?(r.size.width=o.width+l,r.size.height=o.height+c,r.position.top=u.top-c):/^(sw)$/.test(a)?(r.size.width=o.width+l,r.size.height=o.height+c,r.position.left=u.left-l):(r.size.width=o.width+l,r.size.height=o.height+c,r.position.top=u.top-c,r.position.left=u.left-l)}});var n=function(e){return parseInt(e,10)||0},r=function(e){return!isNaN(parseInt(e,10))}}(jQuery),function(e,t){e.widget("ui.selectable",e.ui.mouse,{options:{appendTo:"body",autoRefresh:!0,distance:0,filter:"*",tolerance:"touch"},_create:function(){var t=this;this.element.addClass("ui-selectable"),this.dragged=!1;var n;this.refresh=function(){n=e(t.options.filter,t.element[0]),n.addClass("ui-selectee"),n.each(function(){var t=e(this),n=t.offset();e.data(this,"selectable-item",{element:this,$element:t,left:n.left,top:n.top,right:n.left+t.outerWidth(),bottom:n.top+t.outerHeight(),startselected:!1,selected:t.hasClass("ui-selected"),selecting:t.hasClass("ui-selecting"),unselecting:t.hasClass("ui-unselecting")})})},this.refresh(),this.selectees=n.addClass("ui-selectee"),this._mouseInit(),this.helper=e("<div class='ui-selectable-helper'></div>")},destroy:function(){return this.selectees.removeClass("ui-selectee").removeData("selectable-item"),this.element.removeClass("ui-selectable ui-selectable-disabled").removeData("selectable").unbind(".selectable"),this._mouseDestroy(),this},_mouseStart:function(t){var n=this;this.opos=[t.pageX,t.pageY];if(this.options.disabled)return;var r=this.options;this.selectees=e(r.filter,this.element[0]),this._trigger("start",t),e(r.appendTo).append(this.helper),this.helper.css({left:t.clientX,top:t.clientY,width:0,height:0}),r.autoRefresh&&this.refresh(),this.selectees.filter(".ui-selected").each(function(){var r=e.data(this,"selectable-item");r.startselected=!0,!t.metaKey&&!t.ctrlKey&&(r.$element.removeClass("ui-selected"),r.selected=!1,r.$element.addClass("ui-unselecting"),r.unselecting=!0,n._trigger("unselecting",t,{unselecting:r.element}))}),e(t.target).parents().andSelf().each(function(){var r=e.data(this,"selectable-item");if(r){var i=!t.metaKey&&!t.ctrlKey||!r.$element.hasClass("ui-selected");return r.$element.removeClass(i?"ui-unselecting":"ui-selected").addClass(i?"ui-selecting":"ui-unselecting"),r.unselecting=!i,r.selecting=i,r.selected=i,i?n._trigger("selecting",t,{selecting:r.element}):n._trigger("unselecting",t,{unselecting:r.element}),!1}})},_mouseDrag:function(t){var n=this;this.dragged=!0;if(this.options.disabled)return;var r=this.options,i=this.opos[0],s=this.opos[1],o=t.pageX,u=t.pageY;if(i>o){var a=o;o=i,i=a}if(s>u){var a=u;u=s,s=a}return this.helper.css({left:i,top:s,width:o-i,height:u-s}),this.selectees.each(function(){var a=e.data(this,"selectable-item");if(!a||a.element==n.element[0])return;var f=!1;r.tolerance=="touch"?f=!(a.left>o||a.right<i||a.top>u||a.bottom<s):r.tolerance=="fit"&&(f=a.left>i&&a.right<o&&a.top>s&&a.bottom<u),f?(a.selected&&(a.$element.removeClass("ui-selected"),a.selected=!1),a.unselecting&&(a.$element.removeClass("ui-unselecting"),a.unselecting=!1),a.selecting||(a.$element.addClass("ui-selecting"),a.selecting=!0,n._trigger("selecting",t,{selecting:a.element}))):(a.selecting&&((t.metaKey||t.ctrlKey)&&a.startselected?(a.$element.removeClass("ui-selecting"),a.selecting=!1,a.$element.addClass("ui-selected"),a.selected=!0):(a.$element.removeClass("ui-selecting"),a.selecting=!1,a.startselected&&(a.$element.addClass("ui-unselecting"),a.unselecting=!0),n._trigger("unselecting",t,{unselecting:a.element}))),a.selected&&!t.metaKey&&!t.ctrlKey&&!a.startselected&&(a.$element.removeClass("ui-selected"),a.selected=!1,a.$element.addClass("ui-unselecting"),a.unselecting=!0,n._trigger("unselecting",t,{unselecting:a.element})))}),!1},_mouseStop:function(t){var n=this;this.dragged=!1;var r=this.options;return e(".ui-unselecting",this.element[0]).each(function(){var r=e.data(this,"selectable-item");r.$element.removeClass("ui-unselecting"),r.unselecting=!1,r.startselected=!1,n._trigger("unselected",t,{unselected:r.element})}),e(".ui-selecting",this.element[0]).each(function(){var r=e.data(this,"selectable-item");r.$element.removeClass("ui-selecting").addClass("ui-selected"),r.selecting=!1,r.selected=!0,r.startselected=!0,n._trigger("selected",t,{selected:r.element})}),this._trigger("stop",t),this.helper.remove(),!1}}),e.extend(e.ui.selectable,{version:"@VERSION"})}(jQuery),function(e,t){e.widget("ui.sortable",e.ui.mouse,{widgetEventPrefix:"sort",ready:!1,options:{appendTo:"parent",axis:!1,connectWith:!1,containment:!1,cursor:"auto",cursorAt:!1,dropOnEmpty:!0,forcePlaceholderSize:!1,forceHelperSize:!1,grid:!1,handle:!1,helper:"original",items:"> *",opacity:!1,placeholder:!1,revert:!1,scroll:!0,scrollSensitivity:20,scrollSpeed:20,scope:"default",tolerance:"intersect",zIndex:1e3},_create:function(){var e=this.options;this.containerCache={},this.element.addClass("ui-sortable"),this.refresh(),this.floating=this.items.length?e.axis==="x"||/left|right/.test(this.items[0].item.css("float"))||/inline|table-cell/.test(this.items[0].item.css("display")):!1,this.offset=this.element.offset(),this._mouseInit(),this.ready=!0},destroy:function(){e.Widget.prototype.destroy.call(this),this.element.removeClass("ui-sortable ui-sortable-disabled"),this._mouseDestroy();for(var t=this.items.length-1;t>=0;t--)this.items[t].item.removeData(this.widgetName+"-item");return this},_setOption:function(t,n){t==="disabled"?(this.options[t]=n,this.widget()[n?"addClass":"removeClass"]("ui-sortable-disabled")):e.Widget.prototype._setOption.apply(this,arguments)},_mouseCapture:function(t,n){var r=this;if(this.reverting)return!1;if(this.options.disabled||this.options.type=="static")return!1;this._refreshItems(t);var i=null,s=this,o=e(t.target).parents().each(function(){if(e.data(this,r.widgetName+"-item")==s)return i=e(this),!1});e.data(t.target,r.widgetName+"-item")==s&&(i=e(t.target));if(!i)return!1;if(this.options.handle&&!n){var u=!1;e(this.options.handle,i).find("*").andSelf().each(function(){this==t.target&&(u=!0)});if(!u)return!1}return this.currentItem=i,this._removeCurrentsFromItems(),!0},_mouseStart:function(t,n,r){var i=this.options,s=this;this.currentContainer=this,this.refreshPositions(),this.helper=this._createHelper(t),this._cacheHelperProportions(),this._cacheMargins(),this.scrollParent=this.helper.scrollParent(),this.offset=this.currentItem.offset(),this.offset={top:this.offset.top-this.margins.top,left:this.offset.left-this.margins.left},this.helper.css("position","absolute"),this.cssPosition=this.helper.css("position"),e.extend(this.offset,{click:{left:t.pageX-this.offset.left,top:t.pageY-this.offset.top},parent:this._getParentOffset(),relative:this._getRelativeOffset()}),this.originalPosition=this._generatePosition(t),this.originalPageX=t.pageX,this.originalPageY=t.pageY,i.cursorAt&&this._adjustOffsetFromHelper(i.cursorAt),this.domPosition={prev:this.currentItem.prev()[0],parent:this.currentItem.parent()[0]},this.helper[0]!=this.currentItem[0]&&this.currentItem.hide(),this._createPlaceholder(),i.containment&&this._setContainment(),i.cursor&&(e("body").css("cursor")&&(this._storedCursor=e("body").css("cursor")),e("body").css("cursor",i.cursor)),i.opacity&&(this.helper.css("opacity")&&(this._storedOpacity=this.helper.css("opacity")),this.helper.css("opacity",i.opacity)),i.zIndex&&(this.helper.css("zIndex")&&(this._storedZIndex=this.helper.css("zIndex")),this.helper.css("zIndex",i.zIndex)),this.scrollParent[0]!=document&&this.scrollParent[0].tagName!="HTML"&&(this.overflowOffset=this.scrollParent.offset()),this._trigger("start",t,this._uiHash()),this._preserveHelperProportions||this._cacheHelperProportions();if(!r)for(var o=this.containers.length-1;o>=0;o--)this.containers[o]._trigger("activate",t,s._uiHash(this));return e.ui.ddmanager&&(e.ui.ddmanager.current=this),e.ui.ddmanager&&!i.dropBehaviour&&e.ui.ddmanager.prepareOffsets(this,t),this.dragging=!0,this.helper.addClass("ui-sortable-helper"),this._mouseDrag(t),!0},_mouseDrag:function(t){this.position=this._generatePosition(t),this.positionAbs=this._convertPositionTo("absolute"),this.lastPositionAbs||(this.lastPositionAbs=this.positionAbs);if(this.options.scroll){var n=this.options,r=!1;this.scrollParent[0]!=document&&this.scrollParent[0].tagName!="HTML"?(this.overflowOffset.top+this.scrollParent[0].offsetHeight-t.pageY<n.scrollSensitivity?this.scrollParent[0].scrollTop=r=this.scrollParent[0].scrollTop+n.scrollSpeed:t.pageY-this.overflowOffset.top<n.scrollSensitivity&&(this.scrollParent[0].scrollTop=r=this.scrollParent[0].scrollTop-n.scrollSpeed),this.overflowOffset.left+this.scrollParent[0].offsetWidth-t.pageX<n.scrollSensitivity?this.scrollParent[0].scrollLeft=r=this.scrollParent[0].scrollLeft+n.scrollSpeed:t.pageX-this.overflowOffset.left<n.scrollSensitivity&&(this.scrollParent[0].scrollLeft=r=this.scrollParent[0].scrollLeft-n.scrollSpeed)):(t.pageY-e(document).scrollTop()<n.scrollSensitivity?r=e(document).scrollTop(e(document).scrollTop()-n.scrollSpeed):e(window).height()-(t.pageY-e(document).scrollTop())<n.scrollSensitivity&&(r=e(document).scrollTop(e(document).scrollTop()+n.scrollSpeed)),t.pageX-e(document).scrollLeft()<n.scrollSensitivity?r=e(document).scrollLeft(e(document).scrollLeft()-n.scrollSpeed):e(window).width()-(t.pageX-e(document).scrollLeft())<n.scrollSensitivity&&(r=e(document).scrollLeft(e(document).scrollLeft()+n.scrollSpeed))),r!==!1&&e.ui.ddmanager&&!n.dropBehaviour&&e.ui.ddmanager.prepareOffsets(this,t)}this.positionAbs=this._convertPositionTo("absolute");if(!this.options.axis||this.options.axis!="y")this.helper[0].style.left=this.position.left+"px";if(!this.options.axis||this.options.axis!="x")this.helper[0].style.top=this.position.top+"px";for(var i=this.items.length-1;i>=0;i--){var s=this.items[i],o=s.item[0],u=this._intersectsWithPointer(s);if(!u)continue;if(o!=this.currentItem[0]&&this.placeholder[u==1?"next":"prev"]()[0]!=o&&!e.ui.contains(this.placeholder[0],o)&&(this.options.type=="semi-dynamic"?!e.ui.contains(this.element[0],o):!0)){this.direction=u==1?"down":"up";if(this.options.tolerance!="pointer"&&!this._intersectsWithSides(s))break;this._rearrange(t,s),this._trigger("change",t,this._uiHash());break}}return this._contactContainers(t),e.ui.ddmanager&&e.ui.ddmanager.drag(this,t),this._trigger("sort",t,this._uiHash()),this.lastPositionAbs=this.positionAbs,!1},_mouseStop:function(t,n){if(!t)return;e.ui.ddmanager&&!this.options.dropBehaviour&&e.ui.ddmanager.drop(this,t);if(this.options.revert){var r=this,i=r.placeholder.offset();r.reverting=!0,e(this.helper).animate({left:i.left-this.offset.parent.left-r.margins.left+(this.offsetParent[0]==document.body?0:this.offsetParent[0].scrollLeft),top:i.top-this.offset.parent.top-r.margins.top+(this.offsetParent[0]==document.body?0:this.offsetParent[0].scrollTop)},parseInt(this.options.revert,10)||500,function(){r._clear(t)})}else this._clear(t,n);return!1},cancel:function(){var t=this;if(this.dragging){this._mouseUp({target:null}),this.options.helper=="original"?this.currentItem.css(this._storedCSS).removeClass("ui-sortable-helper"):this.currentItem.show();for(var n=this.containers.length-1;n>=0;n--)this.containers[n]._trigger("deactivate",null,t._uiHash(this)),this.containers[n].containerCache.over&&(this.containers[n]._trigger("out",null,t._uiHash(this)),this.containers[n].containerCache.over=0)}return this.placeholder&&(this.placeholder[0].parentNode&&this.placeholder[0].parentNode.removeChild(this.placeholder[0]),this.options.helper!="original"&&this.helper&&this.helper[0].parentNode&&this.helper.remove(),e.extend(this,{helper:null,dragging:!1,reverting:!1,_noFinalSort:null}),this.domPosition.prev?e(this.domPosition.prev).after(this.currentItem):e(this.domPosition.parent).prepend(this.currentItem)),this},serialize:function(t){var n=this._getItemsAsjQuery(t&&t.connected),r=[];return t=t||{},e(n).each(function(){var n=(e(t.item||this).attr(t.attribute||"id")||"").match(t.expression||/(.+)[-=_](.+)/);n&&r.push((t.key||n[1]+"[]")+"="+(t.key&&t.expression?n[1]:n[2]))}),!r.length&&t.key&&r.push(t.key+"="),r.join("&")},toArray:function(t){var n=this._getItemsAsjQuery(t&&t.connected),r=[];return t=t||{},n.each(function(){r.push(e(t.item||this).attr(t.attribute||"id")||"")}),r},_intersectsWith:function(e){var t=this.positionAbs.left,n=t+this.helperProportions.width,r=this.positionAbs.top,i=r+this.helperProportions.height,s=e.left,o=s+e.width,u=e.top,a=u+e.height,f=this.offset.click.top,l=this.offset.click.left,c=r+f>u&&r+f<a&&t+l>s&&t+l<o;return this.options.tolerance=="pointer"||this.options.forcePointerForContainers||this.options.tolerance!="pointer"&&this.helperProportions[this.floating?"width":"height"]>e[this.floating?"width":"height"]?c:s<t+this.helperProportions.width/2&&n-this.helperProportions.width/2<o&&u<r+this.helperProportions.height/2&&i-this.helperProportions.height/2<a},_intersectsWithPointer:function(t){var n=e.ui.isOverAxis(this.positionAbs.top+this.offset.click.top,t.top,t.height),r=e.ui.isOverAxis(this.positionAbs.left+this.offset.click.left,t.left,t.width),i=n&&r,s=this._getDragVerticalDirection(),o=this._getDragHorizontalDirection();return i?this.floating?o&&o=="right"||s=="down"?2:1:s&&(s=="down"?2:1):!1},_intersectsWithSides:function(t){var n=e.ui.isOverAxis(this.positionAbs.top+this.offset.click.top,t.top+t.height/2,t.height),r=e.ui.isOverAxis(this.positionAbs.left+this.offset.click.left,t.left+t.width/2,t.width),i=this._getDragVerticalDirection(),s=this._getDragHorizontalDirection();return this.floating&&s?s=="right"&&r||s=="left"&&!r:i&&(i=="down"&&n||i=="up"&&!n)},_getDragVerticalDirection:function(){var e=this.positionAbs.top-this.lastPositionAbs.top;return e!=0&&(e>0?"down":"up")},_getDragHorizontalDirection:function(){var e=this.positionAbs.left-this.lastPositionAbs.left;return e!=0&&(e>0?"right":"left")},refresh:function(e){return this._refreshItems(e),this.refreshPositions(),this},_connectWith:function(){var e=this.options;return e.connectWith.constructor==String?[e.connectWith]:e.connectWith},_getItemsAsjQuery:function(t){var n=this,r=[],i=[],s=this._connectWith();if(s&&t)for(var o=s.length-1;o>=0;o--){var u=e(s[o]);for(var a=u.length-1;a>=0;a--){var f=e.data(u[a],this.widgetName);f&&f!=this&&!f.options.disabled&&i.push([e.isFunction(f.options.items)?f.options.items.call(f.element):e(f.options.items,f.element).not(".ui-sortable-helper").not(".ui-sortable-placeholder"),f])}}i.push([e.isFunction(this.options.items)?this.options.items.call(this.element,null,{options:this.options,item:this.currentItem}):e(this.options.items,this.element).not(".ui-sortable-helper").not(".ui-sortable-placeholder"),this]);for(var o=i.length-1;o>=0;o--)i[o][0].each(function(){r.push(this)});return e(r)},_removeCurrentsFromItems:function(){var e=this.currentItem.find(":data("+this.widgetName+"-item)");for(var t=0;t<this.items.length;t++)for(var n=0;n<e.length;n++)e[n]==this.items[t].item[0]&&this.items.splice(t,1)},_refreshItems:function(t){this.items=[],this.containers=[this];var n=this.items,r=this,i=[[e.isFunction(this.options.items)?this.options.items.call(this.element[0],t,{item:this.currentItem}):e(this.options.items,this.element),this]],s=this._connectWith();if(s&&this.ready)for(var o=s.length-1;o>=0;o--){var u=e(s[o]);for(var a=u.length-1;a>=0;a--){var f=e.data(u[a],this.widgetName);f&&f!=this&&!f.options.disabled&&(i.push([e.isFunction(f.options.items)?f.options.items.call(f.element[0],t,{item:this.currentItem}):e(f.options.items,f.element),f]),this.containers.push(f))}}for(var o=i.length-1;o>=0;o--){var l=i[o][1],c=i[o][0];for(var a=0,h=c.length;a<h;a++){var p=e(c[a]);p.data(this.widgetName+"-item",l),n.push({item:p,instance:l,width:0,height:0,left:0,top:0})}}},refreshPositions:function(t){this.offsetParent&&this.helper&&(this.offset.parent=this._getParentOffset());for(var n=this.items.length-1;n>=0;n--){var r=this.items[n];if(r.instance!=this.currentContainer&&this.currentContainer&&r.item[0]!=this.currentItem[0])continue;var i=this.options.toleranceElement?e(this.options.toleranceElement,r.item):r.item;t||(r.width=i.outerWidth(),r.height=i.outerHeight());var s=i.offset();r.left=s.left,r.top=s.top}if(this.options.custom&&this.options.custom.refreshContainers)this.options.custom.refreshContainers.call(this);else for(var n=this.containers.length-1;n>=0;n--){var s=this.containers[n].element.offset();this.containers[n].containerCache.left=s.left,this.containers[n].containerCache.top=s.top,this.containers[n].containerCache.width=this.containers[n].element.outerWidth(),this.containers[n].containerCache.height=this.containers[n].element.outerHeight()}return this},_createPlaceholder:function(t){var n=t||this,r=n.options;if(!r.placeholder||r.placeholder.constructor==String){var i=r.placeholder;r.placeholder={element:function(){var t=e(document.createElement(n.currentItem[0].nodeName)).addClass(i||n.currentItem[0].className+" ui-sortable-placeholder").removeClass("ui-sortable-helper").html("&nbsp;")[0];return i||(t.style.visibility="hidden"),t},update:function(e,t){if(i&&!r.forcePlaceholderSize)return;t.height()||t.height(n.currentItem.innerHeight()-parseInt(n.currentItem.css("paddingTop")||0,10)-parseInt(n.currentItem.css("paddingBottom")||0,10)),t.width()||t.width(n.currentItem.innerWidth()-parseInt(n.currentItem.css("paddingLeft")||0,10)-parseInt(n.currentItem.css("paddingRight")||0,10))}}}n.placeholder=e(r.placeholder.element.call(n.element,n.currentItem)),n.currentItem.after(n.placeholder),r.placeholder.update(n,n.placeholder)},_contactContainers:function(t){var n=null,r=null;for(var i=this.containers.length-1;i>=0;i--){if(e.ui.contains(this.currentItem[0],this.containers[i].element[0]))continue;if(this._intersectsWith(this.containers[i].containerCache)){if(n&&e.ui.contains(this.containers[i].element[0],n.element[0]))continue;n=this.containers[i],r=i}else this.containers[i].containerCache.over&&(this.containers[i]._trigger("out",t,this._uiHash(this)),this.containers[i].containerCache.over=0)}if(!n)return;if(this.containers.length===1)this.containers[r]._trigger("over",t,this._uiHash(this)),this.containers[r].containerCache.over=1;else if(this.currentContainer!=this.containers[r]){var s=1e4,o=null,u=this.positionAbs[this.containers[r].floating?"left":"top"];for(var a=this.items.length-1;a>=0;a--){if(!e.ui.contains(this.containers[r].element[0],this.items[a].item[0]))continue;var f=this.items[a][this.containers[r].floating?"left":"top"];Math.abs(f-u)<s&&(s=Math.abs(f-u),o=this.items[a])}if(!o&&!this.options.dropOnEmpty)return;this.currentContainer=this.containers[r],o?this._rearrange(t,o,null,!0):this._rearrange(t,null,this.containers[r].element,!0),this._trigger("change",t,this._uiHash()),this.containers[r]._trigger("change",t,this._uiHash(this)),this.options.placeholder.update(this.currentContainer,this.placeholder),this.containers[r]._trigger("over",t,this._uiHash(this)),this.containers[r].containerCache.over=1}},_createHelper:function(t){var n=this.options,r=e.isFunction(n.helper)?e(n.helper.apply(this.element[0],[t,this.currentItem])):n.helper=="clone"?this.currentItem.clone():this.currentItem;return r.parents("body").length||e(n.appendTo!="parent"?n.appendTo:this.currentItem[0].parentNode)[0].appendChild(r[0]),r[0]==this.currentItem[0]&&(this._storedCSS={width:this.currentItem[0].style.width,height:this.currentItem[0].style.height,position:this.currentItem.css("position"),top:this.currentItem.css("top"),left:this.currentItem.css("left")}),(r[0].style.width==""||n.forceHelperSize)&&r.width(this.currentItem.width()),(r[0].style.height==""||n.forceHelperSize)&&r.height(this.currentItem.height()),r},_adjustOffsetFromHelper:function(t){typeof t=="string"&&(t=t.split(" ")),e.isArray(t)&&(t={left:+t[0],top:+t[1]||0}),"left"in t&&(this.offset.click.left=t.left+this.margins.left),"right"in t&&(this.offset.click.left=this.helperProportions.width-t.right+this.margins.left),"top"in t&&(this.offset.click.top=t.top+this.margins.top),"bottom"in t&&(this.offset.click.top=this.helperProportions.height-t.bottom+this.margins.top)},_getParentOffset:function(){this.offsetParent=this.helper.offsetParent();var t=this.offsetParent.offset();this.cssPosition=="absolute"&&this.scrollParent[0]!=document&&e.ui.contains(this.scrollParent[0],this.offsetParent[0])&&(t.left+=this.scrollParent.scrollLeft(),t.top+=this.scrollParent.scrollTop());if(this.offsetParent[0]==document.body||this.offsetParent[0].tagName&&this.offsetParent[0].tagName.toLowerCase()=="html"&&e.browser.msie)t={top:0,left:0};return{top:t.top+(parseInt(this.offsetParent.css("borderTopWidth"),10)||0),left:t.left+(parseInt(this.offsetParent.css("borderLeftWidth"),10)||0)}},_getRelativeOffset:function(){if(this.cssPosition=="relative"){var e=this.currentItem.position();return{top:e.top-(parseInt(this.helper.css("top"),10)||0)+this.scrollParent.scrollTop(),left:e.left-(parseInt(this.helper.css("left"),10)||0)+this.scrollParent.scrollLeft()}}return{top:0,left:0}},_cacheMargins:function(){this.margins={left:parseInt(this.currentItem.css("marginLeft"),10)||0,top:parseInt(this.currentItem.css("marginTop"),10)||0}},_cacheHelperProportions:function(){this.helperProportions={width:this.helper.outerWidth(),height:this.helper.outerHeight()}},_setContainment:function(){var t=this.options;t.containment=="parent"&&(t.containment=this.helper[0].parentNode);if(t.containment=="document"||t.containment=="window")this.containment=[0-this.offset.relative.left-this.offset.parent.left,0-this.offset.relative.top-this.offset.parent.top,e(t.containment=="document"?document:window).width()-this.helperProportions.width-this.margins.left,(e(t.containment=="document"?document:window).height()||document.body.parentNode.scrollHeight)-this.helperProportions.height-this.margins.top];if(!/^(document|window|parent)$/.test(t.containment)){var n=e(t.containment)[0],r=e(t.containment).offset(),i=e(n).css("overflow")!="hidden";this.containment=[r.left+(parseInt(e(n).css("borderLeftWidth"),10)||0)+(parseInt(e(n).css("paddingLeft"),10)||0)-this.margins.left,r.top+(parseInt(e(n).css("borderTopWidth"),10)||0)+(parseInt(e(n).css("paddingTop"),10)||0)-this.margins.top,r.left+(i?Math.max(n.scrollWidth,n.offsetWidth):n.offsetWidth)-(parseInt(e(n).css("borderLeftWidth"),10)||0)-(parseInt(e(n).css("paddingRight"),10)||0)-this.helperProportions.width-this.margins.left,r.top+(i?Math.max(n.scrollHeight,n.offsetHeight):n.offsetHeight)-(parseInt(e(n).css("borderTopWidth"),10)||0)-(parseInt(e(n).css("paddingBottom"),10)||0)-this.helperProportions.height-this.margins.top]}},_convertPositionTo:function(t,n){n||(n=this.position);var r=t=="absolute"?1:-1,i=this.options,s=this.cssPosition!="absolute"||this.scrollParent[0]!=document&&!!e.ui.contains(this.scrollParent[0],this.offsetParent[0])?this.scrollParent:this.offsetParent,o=/(html|body)/i.test(s[0].tagName);return{top:n.top+this.offset.relative.top*r+this.offset.parent.top*r-(e.browser.safari&&this.cssPosition=="fixed"?0:(this.cssPosition=="fixed"?-this.scrollParent.scrollTop():o?0:s.scrollTop())*r),left:n.left+this.offset.relative.left*r+this.offset.parent.left*r-(e.browser.safari&&this.cssPosition=="fixed"?0:(this.cssPosition=="fixed"?-this.scrollParent.scrollLeft():o?0:s.scrollLeft())*r)}},_generatePosition:function(t){var n=this.options,r=this.cssPosition!="absolute"||this.scrollParent[0]!=document&&!!e.ui.contains(this.scrollParent[0],this.offsetParent[0])?this.scrollParent:this.offsetParent,i=/(html|body)/i.test(r[0].tagName);this.cssPosition=="relative"&&(this.scrollParent[0]==document||this.scrollParent[0]==this.offsetParent[0])&&(this.offset.relative=this._getRelativeOffset());var s=t.pageX,o=t.pageY;if(this.originalPosition){this.containment&&(t.pageX-this.offset.click.left<this.containment[0]&&(s=this.containment[0]+this.offset.click.left),t.pageY-this.offset.click.top<this.containment[1]&&(o=this.containment[1]+this.offset.click.top),t.pageX-this.offset.click.left>this.containment[2]&&(s=this.containment[2]+this.offset.click.left),t.pageY-this.offset.click.top>this.containment[3]&&(o=this.containment[3]+this.offset.click.top));if(n.grid){var u=this.originalPageY+Math.round((o-this.originalPageY)/n.grid[1])*n.grid[1];o=this.containment?u-this.offset.click.top<this.containment[1]||u-this.offset.click.top>this.containment[3]?u-this.offset.click.top<this.containment[1]?u+n.grid[1]:u-n.grid[1]:u:u;var a=this.originalPageX+Math.round((s-this.originalPageX)/n.grid[0])*n.grid[0];s=this.containment?a-this.offset.click.left<this.containment[0]||a-this.offset.click.left>this.containment[2]?a-this.offset.click.left<this.containment[0]?a+n.grid[0]:a-n.grid[0]:a:a}}return{top:o-this.offset.click.top-this.offset.relative.top-this.offset.parent.top+(e.browser.safari&&this.cssPosition=="fixed"?0:this.cssPosition=="fixed"?-this.scrollParent.scrollTop():i?0:r.scrollTop()),left:s-this.offset.click.left-this.offset.relative.left-this.offset.parent.left+(e.browser.safari&&this.cssPosition=="fixed"?0:this.cssPosition=="fixed"?-this.scrollParent.scrollLeft():i?0:r.scrollLeft())}},_rearrange:function(e,t,n,r){n?n[0].appendChild(this.placeholder[0]):t.item[0].parentNode.insertBefore(this.placeholder[0],this.direction=="down"?t.item[0]:t.item[0].nextSibling),this.counter=this.counter?++this.counter:1;var i=this,s=this.counter;window.setTimeout(function(){s==i.counter&&i.refreshPositions(!r)},0)},_clear:function(t,n){this.reverting=!1;var r=[],i=this;!this._noFinalSort&&this.currentItem.parent().length&&this.placeholder.before(this.currentItem),this._noFinalSort=null;if(this.helper[0]==this.currentItem[0]){for(var s in this._storedCSS)if(this._storedCSS[s]=="auto"||this._storedCSS[s]=="static")this._storedCSS[s]="";this.currentItem.css(this._storedCSS).removeClass("ui-sortable-helper")}else this.currentItem.show();this.fromOutside&&!n&&r.push(function(e){this._trigger("receive",e,this._uiHash(this.fromOutside))}),(this.fromOutside||this.domPosition.prev!=this.currentItem.prev().not(".ui-sortable-helper")[0]||this.domPosition.parent!=this.currentItem.parent()[0])&&!n&&r.push(function(e){this._trigger("update",e,this._uiHash())});if(!e.ui.contains(this.element[0],this.currentItem[0])){n||r.push(function(e){this._trigger("remove",e,this._uiHash())});for(var s=this.containers.length-1;s>=0;s--)e.ui.contains(this.containers[s].element[0],this.currentItem[0])&&!n&&(r.push(function(e){return function(t){e._trigger("receive",t,this._uiHash(this))}}.call(this,this.containers[s])),r.push(function(e){return function(t){e._trigger("update",t,this._uiHash(this))}}.call(this,this.containers[s])))}for(var s=this.containers.length-1;s>=0;s--)n||r.push(function(e){return function(t){e._trigger("deactivate",t,this._uiHash(this))}}.call(this,this.containers[s])),this.containers[s].containerCache.over&&(r.push(function(e){return function(t){e._trigger("out",t,this._uiHash(this))}}.call(this,this.containers[s])),this.containers[s].containerCache.over=0);this._storedCursor&&e("body").css("cursor",this._storedCursor),this._storedOpacity&&this.helper.css("opacity",this._storedOpacity),this._storedZIndex&&this.helper.css("zIndex",this._storedZIndex=="auto"?"":this._storedZIndex),this.dragging=!1;if(this.cancelHelperRemoval){if(!n){this._trigger("beforeStop",t,this._uiHash());for(var s=0;s<r.length;s++)r[s].call(this,t);this._trigger("stop",t,this._uiHash())}return!1}n||this._trigger("beforeStop",t,this._uiHash()),this.placeholder[0].parentNode.removeChild(this.placeholder[0]),this.helper[0]!=this.currentItem[0]&&this.helper.remove(),this.helper=null;if(!n){for(var s=0;s<r.length;s++)r[s].call(this,t);this._trigger("stop",t,this._uiHash())}return this.fromOutside=!1,!0},_trigger:function(){e.Widget.prototype._trigger.apply(this,arguments)===!1&&this.cancel()},_uiHash:function(t){var n=t||this;return{helper:n.helper,placeholder:n.placeholder||e([]),position:n.position,originalPosition:n.originalPosition,offset:n.positionAbs,item:n.currentItem,sender:t?t.element:null}}}),e.extend(e.ui.sortable,{version:"@VERSION"})}(jQuery),jQuery.effects||function(e,t){function n(t){var n;return t&&t.constructor==Array&&t.length==3?t:(n=/rgb\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*\)/.exec(t))?[parseInt(n[1],10),parseInt(n[2],10),parseInt(n[3],10)]:(n=/rgb\(\s*([0-9]+(?:\.[0-9]+)?)\%\s*,\s*([0-9]+(?:\.[0-9]+)?)\%\s*,\s*([0-9]+(?:\.[0-9]+)?)\%\s*\)/.exec(t))?[parseFloat(n[1])*2.55,parseFloat(n[2])*2.55,parseFloat(n[3])*2.55]:(n=/#([a-fA-F0-9]{2})([a-fA-F0-9]{2})([a-fA-F0-9]{2})/.exec(t))?[parseInt(n[1],16),parseInt(n[2],16),parseInt(n[3],16)]:(n=/#([a-fA-F0-9])([a-fA-F0-9])([a-fA-F0-9])/.exec(t))?[parseInt(n[1]+n[1],16),parseInt(n[2]+n[2],16),parseInt(n[3]+n[3],16)]:(n=/rgba\(0, 0, 0, 0\)/.exec(t))?i.transparent:i[e.trim(t).toLowerCase()]}function r(t,r){var i;do{i=e.curCSS(t,r);if(i!=""&&i!="transparent"||e.nodeName(t,"body"))break;r="backgroundColor"}while(t=t.parentNode);return n(i)}function u(){var e=document.defaultView?document.defaultView.getComputedStyle(this,null):this.currentStyle,t={},n,r;if(e&&e.length&&e[0]&&e[e[0]]){var i=e.length;while(i--)n=e[i],typeof e[n]=="string"&&(r=n.replace(/\-(\w)/g,function(e,t){return t.toUpperCase()}),t[r]=e[n])}else for(n in e)typeof e[n]=="string"&&(t[n]=e[n]);return t}function a(t){var n,r;for(n in t)r=t[n],(r==null||e.isFunction(r)||n in o||/scrollbar/.test(n)||!/color/i.test(n)&&isNaN(parseFloat(r)))&&delete t[n];return t}function f(e,t){var n={_:0},r;for(r in t)e[r]!=t[r]&&(n[r]=t[r]);return n}function l(t,n,r,i){typeof t=="object"&&(i=n,r=null,n=t,t=n.effect),e.isFunction(n)&&(i=n,r=null,n={});if(typeof n=="number"||e.fx.speeds[n])i=r,r=n,n={};return e.isFunction(r)&&(i=r,r=null),n=n||{},r=r||n.duration,r=e.fx.off?0:typeof r=="number"?r:r in e.fx.speeds?e.fx.speeds[r]:e.fx.speeds._default,i=i||n.complete,[t,n,r,i]}function c(t){return!t||typeof t=="number"||e.fx.speeds[t]?!0:typeof t=="string"&&!e.effects[t]?!0:!1}e.effects={},e.each(["backgroundColor","borderBottomColor","borderLeftColor","borderRightColor","borderTopColor","borderColor","color","outlineColor"],function(t,i){e.fx.step[i]=function(e){e.colorInit||(e.start=r(e.elem,i),e.end=n(e.end),e.colorInit=!0),e.elem.style[i]="rgb("+Math.max(Math.min(parseInt(e.pos*(e.end[0]-e.start[0])+e.start[0],10),255),0)+","+Math.max(Math.min(parseInt(e.pos*(e.end[1]-e.start[1])+e.start[1],10),255),0)+","+Math.max(Math.min(parseInt(e.pos*(e.end[2]-e.start[2])+e.start[2],10),255),0)+")"}});var i={aqua:[0,255,255],azure:[240,255,255],beige:[245,245,220],black:[0,0,0],blue:[0,0,255],brown:[165,42,42],cyan:[0,255,255],darkblue:[0,0,139],darkcyan:[0,139,139],darkgrey:[169,169,169],darkgreen:[0,100,0],darkkhaki:[189,183,107],darkmagenta:[139,0,139],darkolivegreen:[85,107,47],darkorange:[255,140,0],darkorchid:[153,50,204],darkred:[139,0,0],darksalmon:[233,150,122],darkviolet:[148,0,211],fuchsia:[255,0,255],gold:[255,215,0],green:[0,128,0],indigo:[75,0,130],khaki:[240,230,140],lightblue:[173,216,230],lightcyan:[224,255,255],lightgreen:[144,238,144],lightgrey:[211,211,211],lightpink:[255,182,193],lightyellow:[255,255,224],lime:[0,255,0],magenta:[255,0,255],maroon:[128,0,0],navy:[0,0,128],olive:[128,128,0],orange:[255,165,0],pink:[255,192,203],purple:[128,0,128],violet:[128,0,128],red:[255,0,0],silver:[192,192,192],white:[255,255,255],yellow:[255,255,0],transparent:[255,255,255]},s=["add","remove","toggle"],o={border:1,borderBottom:1,borderColor:1,borderLeft:1,borderRight:1,borderTop:1,borderWidth:1,margin:1,padding:1};e.effects.animateClass=function(t,n,r,i){return e.isFunction(r)&&(i=r,r=null),this.queue(function(){var o=e(this),l=o.attr("style")||" ",c=a(u.call(this)),h,p=o.attr("class")||"";e.each(s,function(e,n){t[n]&&o[n+"Class"](t[n])}),h=a(u.call(this)),o.attr("class",p),o.animate(f(c,h),{queue:!1,duration:n,easing:r,complete:function(){e.each(s,function(e,n){t[n]&&o[n+"Class"](t[n])}),typeof o.attr("style")=="object"?(o.attr("style").cssText="",o.attr("style").cssText=l):o.attr("style",l),i&&i.apply(this,arguments),e.dequeue(this)}})})},e.fn.extend({_addClass:e.fn.addClass,addClass:function(t,n,r,i){return n?e.effects.animateClass.apply(this,[{add:t},n,r,i]):this._addClass(t)},_removeClass:e.fn.removeClass,removeClass:function(t,n,r,i){return n?e.effects.animateClass.apply(this,[{remove:t},n,r,i]):this._removeClass(t)},_toggleClass:e.fn.toggleClass,toggleClass:function(n,r,i,s,o){return typeof r=="boolean"||r===t?i?e.effects.animateClass.apply(this,[r?{add:n}:{remove:n},i,s,o]):this._toggleClass(n,r):e.effects.animateClass.apply(this,[{toggle:n},r,i,s])},switchClass:function(t,n,r,i,s){return e.effects.animateClass.apply(this,[{add:n,remove:t},r,i,s])}}),e.extend(e.effects,{version:"@VERSION",save:function(e,t){for(var n=0;n<t.length;n++)t[n]!==null&&e.data("ec.storage."+t[n],e[0].style[t[n]])},restore:function(e,t){for(var n=0;n<t.length;n++)t[n]!==null&&e.css(t[n],e.data("ec.storage."+t[n]))},setMode:function(e,t){return t=="toggle"&&(t=e.is(":hidden")?"show":"hide"),t},getBaseline:function(e,t){var n,r;switch(e[0]){case"top":n=0;break;case"middle":n=.5;break;case"bottom":n=1;break;default:n=e[0]/t.height}switch(e[1]){case"left":r=0;break;case"center":r=.5;break;case"right":r=1;break;default:r=e[1]/t.width}return{x:r,y:n}},createWrapper:function(t){if(t.parent().is(".ui-effects-wrapper"))return t.parent();var n={width:t.outerWidth(!0),height:t.outerHeight(!0),"float":t.css("float")},r=e("<div></div>").addClass("ui-effects-wrapper").css({fontSize:"100%",background:"transparent",border:"none",margin:0,padding:0}),i=document.activeElement;return t.wrap(r),(t[0]===i||e.contains(t[0],i))&&e(i).focus(),r=t.parent(),t.css("position")=="static"?(r.css({position:"relative"}),t.css({position:"relative"})):(e.extend(n,{position:t.css("position"),zIndex:t.css("z-index")}),e.each(["top","left","bottom","right"],function(e,r){n[r]=t.css(r),isNaN(parseInt(n[r],10))&&(n[r]="auto")}),t.css({position:"relative",top:0,left:0,right:"auto",bottom:"auto"})),r.css(n).show()},removeWrapper:function(t){var n,r=document.activeElement;return t.parent().is(".ui-effects-wrapper")?(n=t.parent().replaceWith(t),(t[0]===r||e.contains(t[0],r))&&e(r).focus(),n):t},setTransition:function(t,n,r,i){return i=i||{},e.each(n,function(e,n){var s=t.cssUnit(n);s[0]>0&&(i[n]=s[0]*r+s[1])}),i}}),e.fn.extend({effect:function(t,n,r,i){var s=l.apply(this,arguments),o={options:s[1],duration:s[2],callback:s[3]},u=o.options.mode,a=e.effects[t];return e.fx.off||!a?u?this[u](o.duration,o.callback):this.each(function(){o.callback&&o.callback.call(this)}):a.call(this,o)},_show:e.fn.show,show:function(e){if(c(e))return this._show.apply(this,arguments);var t=l.apply(this,arguments);return t[1].mode="show",this.effect.apply(this,t)},_hide:e.fn.hide,hide:function(e){if(c(e))return this._hide.apply(this,arguments);var t=l.apply(this,arguments);return t[1].mode="hide",this.effect.apply(this,t)},__toggle:e.fn.toggle,toggle:function(t){if(c(t)||typeof t=="boolean"||e.isFunction(t))return this.__toggle.apply(this,arguments);var n=l.apply(this,arguments);return n[1].mode="toggle",this.effect.apply(this,n)},cssUnit:function(t){var n=this.css(t),r=[];return e.each(["em","px","%","pt"],function(e,t){n.indexOf(t)>0&&(r=[parseFloat(n),t])}),r}}),e.easing.jswing=e.easing.swing,e.extend(e.easing,{def:"easeOutQuad",swing:function(t,n,r,i,s){return e.easing[e.easing.def](t,n,r,i,s)},easeInQuad:function(e,t,n,r,i){return r*(t/=i)*t+n},easeOutQuad:function(e,t,n,r,i){return-r*(t/=i)*(t-2)+n},easeInOutQuad:function(e,t,n,r,i){return(t/=i/2)<1?r/2*t*t+n:-r/2*(--t*(t-2)-1)+n},easeInCubic:function(e,t,n,r,i){return r*(t/=i)*t*t+n},easeOutCubic:function(e,t,n,r,i){return r*((t=t/i-1)*t*t+1)+n},easeInOutCubic:function(e,t,n,r,i){return(t/=i/2)<1?r/2*t*t*t+n:r/2*((t-=2)*t*t+2)+n},easeInQuart:function(e,t,n,r,i){return r*(t/=i)*t*t*t+n},easeOutQuart:function(e,t,n,r,i){return-r*((t=t/i-1)*t*t*t-1)+n},easeInOutQuart:function(e,t,n,r,i){return(t/=i/2)<1?r/2*t*t*t*t+n:-r/2*((t-=2)*t*t*t-2)+n},easeInQuint:function(e,t,n,r,i){return r*(t/=i)*t*t*t*t+n},easeOutQuint:function(e,t,n,r,i){return r*((t=t/i-1)*t*t*t*t+1)+n},easeInOutQuint:function(e,t,n,r,i){return(t/=i/2)<1?r/2*t*t*t*t*t+n:r/2*((t-=2)*t*t*t*t+2)+n},easeInSine:function(e,t,n,r,i){return-r*Math.cos(t/i*(Math.PI/2))+r+n},easeOutSine:function(e,t,n,r,i){return r*Math.sin(t/i*(Math.PI/2))+n},easeInOutSine:function(e,t,n,r,i){return-r/2*(Math.cos(Math.PI*t/i)-1)+n},easeInExpo:function(e,t,n,r,i){return t==0?n:r*Math.pow(2,10*(t/i-1))+n},easeOutExpo:function(e,t,n,r,i){return t==i?n+r:r*(-Math.pow(2,-10*t/i)+1)+n},easeInOutExpo:function(e,t,n,r,i){return t==0?n:t==i?n+r:(t/=i/2)<1?r/2*Math.pow(2,10*(t-1))+n:r/2*(-Math.pow(2,-10*--t)+2)+n},easeInCirc:function(e,t,n,r,i){return-r*(Math.sqrt(1-(t/=i)*t)-1)+n},easeOutCirc:function(e,t,n,r,i){return r*Math.sqrt(1-(t=t/i-1)*t)+n},easeInOutCirc:function(e,t,n,r,i){return(t/=i/2)<1?-r/2*(Math.sqrt(1-t*t)-1)+n:r/2*(Math.sqrt(1-(t-=2)*t)+1)+n},easeInElastic:function(e,t,n,r,i){var s=1.70158,o=0,u=r;if(t==0)return n;if((t/=i)==1)return n+r;o||(o=i*.3);if(u<Math.abs(r)){u=r;var s=o/4}else var s=o/(2*Math.PI)*Math.asin(r/u);return-(u*Math.pow(2,10*(t-=1))*Math.sin((t*i-s)*2*Math.PI/o))+n},easeOutElastic:function(e,t,n,r,i){var s=1.70158,o=0,u=r;if(t==0)return n;if((t/=i)==1)return n+r;o||(o=i*.3);if(u<Math.abs(r)){u=r;var s=o/4}else var s=o/(2*Math.PI)*Math.asin(r/u);return u*Math.pow(2,-10*t)*Math.sin((t*i-s)*2*Math.PI/o)+r+n},easeInOutElastic:function(e,t,n,r,i){var s=1.70158,o=0,u=r;if(t==0)return n;if((t/=i/2)==2)return n+r;o||(o=i*.3*1.5);if(u<Math.abs(r)){u=r;var s=o/4}else var s=o/(2*Math.PI)*Math.asin(r/u);return t<1?-0.5*u*Math.pow(2,10*(t-=1))*Math.sin((t*i-s)*2*Math.PI/o)+n:u*Math.pow(2,-10*(t-=1))*Math.sin((t*i-s)*2*Math.PI/o)*.5+r+n},easeInBack:function(e,n,r,i,s,o){return o==t&&(o=1.70158),i*(n/=s)*n*((o+1)*n-o)+r},easeOutBack:function(e,n,r,i,s,o){return o==t&&(o=1.70158),i*((n=n/s-1)*n*((o+1)*n+o)+1)+r},easeInOutBack:function(e,n,r,i,s,o){return o==t&&(o=1.70158),(n/=s/2)<1?i/2*n*n*(((o*=1.525)+1)*n-o)+r:i/2*((n-=2)*n*(((o*=1.525)+1)*n+o)+2)+r},easeInBounce:function(t,n,r,i,s){return i-e.easing.easeOutBounce(t,s-n,0,i,s)+r},easeOutBounce:function(e,t,n,r,i){return(t/=i)<1/2.75?r*7.5625*t*t+n:t<2/2.75?r*(7.5625*(t-=1.5/2.75)*t+.75)+n:t<2.5/2.75?r*(7.5625*(t-=2.25/2.75)*t+.9375)+n:r*(7.5625*(t-=2.625/2.75)*t+.984375)+n},easeInOutBounce:function(t,n,r,i,s){return n<s/2?e.easing.easeInBounce(t,n*2,0,i,s)*.5+r:e.easing.easeOutBounce(t,n*2-s,0,i,s)*.5+i*.5+r}})}(jQuery),function(e,t){e.effects.blind=function(t){return this.queue(function(){var n=e(this),r=["position","top","bottom","left","right"],i=e.effects.setMode(n,t.options.mode||"hide"),s=t.options.direction||"vertical";e.effects.save(n,r),n.show();var u=e.effects.createWrapper(n).css({overflow:"hidden"}),a=s=="vertical"?"height":"width",f=s=="vertical"?u.height():u.width();i=="show"&&u.css(a,0);var l={};l[a]=i=="show"?f:0,u.animate(l,t.duration,t.options.easing,function(){i=="hide"&&n.hide(),e.effects.restore(n,r),e.effects.removeWrapper(n),t.callback&&t.callback.apply(n[0],arguments),n.dequeue()})})}}(jQuery),function(e,t){e.effects.bounce=function(t){return this.queue(function(){var n=e(this),r=["position","top","bottom","left","right"],i=e.effects.setMode(n,t.options.mode||"effect"),s=t.options.direction||"up",u=t.options.distance||20,a=t.options.times||5,f=t.duration||250;/show|hide/.test(i)&&r.push("opacity"),e.effects.save(n,r),n.show(),e.effects.createWrapper(n);var l=s=="up"||s=="down"?"top":"left",c=s=="up"||s=="left"?"pos":"neg",u=t.options.distance||(l=="top"?n.outerHeight({margin:!0})/3:n.outerWidth({margin:!0})/3);i=="show"&&n.css("opacity",0).css(l,c=="pos"?-u:u),i=="hide"&&(u/=a*2),i!="hide"&&a--;if(i=="show"){var h={opacity:1};h[l]=(c=="pos"?"+=":"-=")+u,n.animate(h,f/2,t.options.easing),u/=2,a--}for(var p=0;p<a;p++){var d={},v={};d[l]=(c=="pos"?"-=":"+=")+u,v[l]=(c=="pos"?"+=":"-=")+u,n.animate(d,f/2,t.options.easing).animate(v,f/2,t.options.easing),u=i=="hide"?u*2:u/2}if(i=="hide"){var h={opacity:0};h[l]=(c=="pos"?"-=":"+=")+u,n.animate(h,f/2,t.options.easing,function(){n.hide(),e.effects.restore(n,r),e.effects.removeWrapper(n),t.callback&&t.callback.apply(this,arguments)})}else{var d={},v={};d[l]=(c=="pos"?"-=":"+=")+u,v[l]=(c=="pos"?"+=":"-=")+u,n.animate(d,f/2,t.options.easing).animate(v,f/2,t.options.easing,function(){e.effects.restore(n,r),e.effects.removeWrapper(n),t.callback&&t.callback.apply(this,arguments)})}n.queue("fx",function(){n.dequeue()}),n.dequeue()})}}(jQuery),function(e,t){e.effects.clip=function(t){return this.queue(function(){var n=e(this),r=["position","top","bottom","left","right","height","width"],i=e.effects.setMode(n,t.options.mode||"hide"),s=t.options.direction||"vertical";e.effects.save(n,r),n.show();var u=e.effects.createWrapper(n).css({overflow:"hidden"}),a=n[0].tagName=="IMG"?u:n,f={size:s=="vertical"?"height":"width",position:s=="vertical"?"top":"left"},l=s=="vertical"?a.height():a.width();i=="show"&&(a.css(f.size,0),a.css(f.position,l/2));var c={};c[f.size]=i=="show"?l:0,c[f.position]=i=="show"?0:l/2,a.animate(c,{queue:!1,duration:t.duration,easing:t.options.easing,complete:function(){i=="hide"&&n.hide(),e.effects.restore(n,r),e.effects.removeWrapper(n),t.callback&&t.callback.apply(n[0],arguments),n.dequeue()}})})}}(jQuery),function(e,t){e.effects.drop=function(t){return this.queue(function(){var n=e(this),r=["position","top","bottom","left","right","opacity"],i=e.effects.setMode(n,t.options.mode||"hide"),s=t.options.direction||"left";e.effects.save(n,r),n.show(),e.effects.createWrapper(n);var u=s=="up"||s=="down"?"top":"left",a=s=="up"||s=="left"?"pos":"neg",f=t.options.distance||(u=="top"?n.outerHeight({margin:!0})/2:n.outerWidth({margin:!0})/2);i=="show"&&n.css("opacity",0).css(u,a=="pos"?-f:f);var l={opacity:i=="show"?1:0};l[u]=(i=="show"?a=="pos"?"+=":"-=":a=="pos"?"-=":"+=")+f,n.animate(l,{queue:!1,duration:t.duration,easing:t.options.easing,complete:function(){i=="hide"&&n.hide(),e.effects.restore(n,r),e.effects.removeWrapper(n),t.callback&&t.callback.apply(this,arguments),n.dequeue()}})})}}(jQuery),function(e,t){e.effects.explode=function(t){return this.queue(function(){var n=t.options.pieces?Math.round(Math.sqrt(t.options.pieces)):3,r=t.options.pieces?Math.round(Math.sqrt(t.options.pieces)):3;t.options.mode=t.options.mode=="toggle"?e(this).is(":visible")?"hide":"show":t.options.mode;var i=e(this).show().css("visibility","hidden"),s=i.offset();s.top-=parseInt(i.css("marginTop"),10)||0,s.left-=parseInt(i.css("marginLeft"),10)||0;var u=i.outerWidth(!0),a=i.outerHeight(!0);for(var f=0;f<n;f++)for(var l=0;l<r;l++)i.clone().appendTo("body").wrap("<div></div>").css({position:"absolute",visibility:"visible",left:-l*(u/r),top:-f*(a/n)}).parent().addClass("ui-effects-explode").css({position:"absolute",overflow:"hidden",width:u/r,height:a/n,left:s.left+l*(u/r)+(t.options.mode=="show"?(l-Math.floor(r/2))*(u/r):0),top:s.top+f*(a/n)+(t.options.mode=="show"?(f-Math.floor(n/2))*(a/n):0),opacity:t.options.mode=="show"?0:1}).animate({left:s.left+l*(u/r)+(t.options.mode=="show"?0:(l-Math.floor(r/2))*(u/r)),top:s.top+f*(a/n)+(t.options.mode=="show"?0:(f-Math.floor(n/2))*(a/n)),opacity:t.options.mode=="show"?1:0},t.duration||500);setTimeout(function(){t.options.mode=="show"?i.css({visibility:"visible"}):i.css({visibility:"visible"}).hide(),t.callback&&t.callback.apply(i[0]),i.dequeue(),e("div.ui-effects-explode").remove()},t.duration||500)})}}(jQuery),function(e,t){e.effects.fade=function(t){return this.queue(function(){var n=e(this),r=e.effects.setMode(n,t.options.mode||"hide");n.animate({opacity:r},{queue:!1,duration:t.duration,easing:t.options.easing,complete:function(){t.callback&&t.callback.apply(this,arguments),n.dequeue()}})})}}(jQuery),function(e,t){e.effects.fold=function(t){return this.queue(function(){var n=e(this),r=["position","top","bottom","left","right"],i=e.effects.setMode(n,t.options.mode||"hide"),s=t.options.size||15,u=!!t.options.horizFirst,a=t.duration?t.duration/2:e.fx.speeds._default/2;e.effects.save(n,r),n.show();var f=e.effects.createWrapper(n).css({overflow:"hidden"}),l=i=="show"!=u,c=l?["width","height"]:["height","width"],h=l?[f.width(),f.height()]:[f.height(),f.width()],p=/([0-9]+)%/.exec(s);p&&(s=parseInt(p[1],10)/100*h[i=="hide"?0:1]),i=="show"&&f.css(u?{height:0,width:s}:{height:s,width:0});var d={},v={};d[c[0]]=i=="show"?h[0]:s,v[c[1]]=i=="show"?h[1]:0,f.animate(d,a,t.options.easing).animate(v,a,t.options.easing,function(){i=="hide"&&n.hide(),e.effects.restore(n,r),e.effects.removeWrapper(n),t.callback&&t.callback.apply(n[0],arguments),n.dequeue()})})}}(jQuery),function(e,t){e.effects.highlight=function(t){return this.queue(function(){var n=e(this),r=["backgroundImage","backgroundColor","opacity"],i=e.effects.setMode(n,t.options.mode||"show"),s={backgroundColor:n.css("backgroundColor")};i=="hide"&&(s.opacity=0),e.effects.save(n,r),n.show().css({backgroundImage:"none",backgroundColor:t.options.color||"#ffff99"}).animate(s,{queue:!1,duration:t.duration,easing:t.options.easing,complete:function(){i=="hide"&&n.hide(),e.effects.restore(n,r),i=="show"&&!e.support.opacity&&this.style.removeAttribute("filter"),t.callback&&t.callback.apply(this,arguments),n.dequeue()}})})}}(jQuery),function(e,t){e.effects.pulsate=function(t){return this.queue(function(){var n=e(this),r=e.effects.setMode(n,t.options.mode||"show"),i=(t.options.times||5)*2-1,s=t.duration?t.duration/2:e.fx.speeds._default/2,u=n.is(":visible"),a=0;u||(n.css("opacity",0).show(),a=1),(r=="hide"&&u||r=="show"&&!u)&&i--;for(var f=0;f<i;f++)n.animate({opacity:a},s,t.options.easing),a=(a+1)%2;n.animate({opacity:a},s,t.options.easing,function(){a==0&&n.hide(),t.callback&&t.callback.apply(this,arguments)}),n.queue("fx",function(){n.dequeue()}).dequeue()})}}(jQuery),function(e,t){e.effects.puff=function(t){return this.queue(function(){var n=e(this),r=e.effects.setMode(n,t.options.mode||"hide"),i=parseInt(t.options.percent,10)||150,s=i/100,u={height:n.height(),width:n.width()};e.extend(t.options,{fade:!0,mode:r,percent:r=="hide"?i:100,from:r=="hide"?u:{height:u.height*s,width:u.width*s}}),n.effect("scale",t.options,t.duration,t.callback),n.dequeue()})},e.effects.scale=function(t){return this.queue(function(){var n=e(this),r=e.extend(!0,{},t.options),i=e.effects.setMode(n,t.options.mode||"effect"),s=parseInt(t.options.percent,10)||(parseInt(t.options.percent,10)==0?0:i=="hide"?0:100),u=t.options.direction||"both",a=t.options.origin;i!="effect"&&(r.origin=a||["middle","center"],r.restore=!0);var f={height:n.height(),width:n.width()};n.from=t.options.from||(i=="show"?{height:0,width:0}:f);var l={y:u!="horizontal"?s/100:1,x:u!="vertical"?s/100:1};n.to={height:f.height*l.y,width:f.width*l.x},t.options.fade&&(i=="show"&&(n.from.opacity=0,n.to.opacity=1),i=="hide"&&(n.from.opacity=1,n.to.opacity=0)),r.from=n.from,r.to=n.to,r.mode=i,n.effect("size",r,t.duration,t.callback),n.dequeue()})},e.effects.size=function(t){return this.queue(function(){var n=e(this),r=["position","top","bottom","left","right","width","height","overflow","opacity"],i=["position","top","bottom","left","right","overflow","opacity"],s=["width","height","overflow"],u=["fontSize"],a=["borderTopWidth","borderBottomWidth","paddingTop","paddingBottom"],f=["borderLeftWidth","borderRightWidth","paddingLeft","paddingRight"],l=e.effects.setMode(n,t.options.mode||"effect"),c=t.options.restore||!1,h=t.options.scale||"both",p=t.options.origin,d={height:n.height(),width:n.width()};n.from=t.options.from||d,n.to=t.options.to||d;if(p){var v=e.effects.getBaseline(p,d);n.from.top=(d.height-n.from.height)*v.y,n.from.left=(d.width-n.from.width)*v.x,n.to.top=(d.height-n.to.height)*v.y,n.to.left=(d.width-n.to.width)*v.x}var m={from:{y:n.from.height/d.height,x:n.from.width/d.width},to:{y:n.to.height/d.height,x:n.to.width/d.width}};if(h=="box"||h=="both")m.from.y!=m.to.y&&(r=r.concat(a),n.from=e.effects.setTransition(n,a,m.from.y,n.from),n.to=e.effects.setTransition(n,a,m.to.y,n.to)),m.from.x!=m.to.x&&(r=r.concat(f),n.from=e.effects.setTransition(n,f,m.from.x,n.from),n.to=e.effects.setTransition(n,f,m.to.x,n.to));(h=="content"||h=="both")&&m.from.y!=m.to.y&&(r=r.concat(u),n.from=e.effects.setTransition(n,u,m.from.y,n.from),n.to=e.effects.setTransition(n,u,m.to.y,n.to)),e.effects.save(n,c?r:i),n.show(),e.effects.createWrapper(n),n.css("overflow","hidden").css(n.from);if(h=="content"||h=="both")a=a.concat(["marginTop","marginBottom"]).concat(u),f=f.concat(["marginLeft","marginRight"]),s=r.concat(a).concat(f),n.find("*[width]").each(function(){var n=e(this);c&&e.effects.save(n,s);var r={height:n.height(),width:n.width()};n.from={height:r.height*m.from.y,width:r.width*m.from.x},n.to={height:r.height*m.to.y,width:r.width*m.to.x},m.from.y!=m.to.y&&(n.from=e.effects.setTransition(n,a,m.from.y,n.from),n.to=e.effects.setTransition(n,a,m.to.y,n.to)),m.from.x!=m.to.x&&(n.from=e.effects.setTransition(n,f,m.from.x,n.from),n.to=e.effects.setTransition(n,f,m.to.x,n.to)),n.css(n.from),n.animate(n.to,t.duration,t.options.easing,function(){c&&e.effects.restore(n,s)})});n.animate(n.to,{queue:!1,duration:t.duration,easing:t.options.easing,complete:function(){n.to.opacity===0&&n.css("opacity",n.from.opacity),l=="hide"&&n.hide(),e.effects.restore(n,c?r:i),e.effects.removeWrapper(n),t.callback&&t.callback.apply(this,arguments),n.dequeue()}})})}}(jQuery),function(e,t){e.effects.shake=function(t){return this.queue(function(){var n=e(this),r=["position","top","bottom","left","right"],i=e.effects.setMode(n,t.options.mode||"effect"),s=t.options.direction||"left",u=t.options.distance||20,a=t.options.times||3,f=t.duration||t.options.duration||140;e.effects.save(n,r),n.show(),e.effects.createWrapper(n);var l=s=="up"||s=="down"?"top":"left",c=s=="up"||s=="left"?"pos":"neg",h={},p={},d={};h[l]=(c=="pos"?"-=":"+=")+u,p[l]=(c=="pos"?"+=":"-=")+u*2,d[l]=(c=="pos"?"-=":"+=")+u*2,n.animate(h,f,t.options.easing);for(var v=1;v<a;v++)n.animate(p,f,t.options.easing).animate(d,f,t.options.easing);n.animate(p,f,t.options.easing).animate(h,f/2,t.options.easing,function(){e.effects.restore(n,r),e.effects.removeWrapper(n),t.callback&&t.callback.apply(this,arguments)}),n.queue("fx",function(){n.dequeue()}),n.dequeue()})}}(jQuery),function(e,t){e.effects.slide=function(t){return this.queue(function(){var n=e(this),r=["position","top","bottom","left","right"],i=e.effects.setMode(n,t.options.mode||"show"),s=t.options.direction||"left";e.effects.save(n,r),n.show(),e.effects.createWrapper(n).css({overflow:"hidden"});var u=s=="up"||s=="down"?"top":"left",a=s=="up"||s=="left"?"pos":"neg",f=t.options.distance||(u=="top"?n.outerHeight({margin:!0}):n.outerWidth({margin:!0}));i=="show"&&n.css(u,a=="pos"?isNaN(f)?"-"+f:-f:f);var l={};l[u]=(i=="show"?a=="pos"?"+=":"-=":a=="pos"?"-=":"+=")+f,n.animate(l,{queue:!1,duration:t.duration,easing:t.options.easing,complete:function(){i=="hide"&&n.hide(),e.effects.restore(n,r),e.effects.removeWrapper(n),t.callback&&t.callback.apply(this,arguments),n.dequeue()}})})}}(jQuery),function(e,t){e.effects.transfer=function(t){return this.queue(function(){var n=e(this),r=e(t.options.to),i=r.offset(),s={top:i.top,left:i.left,height:r.innerHeight(),width:r.innerWidth()},u=n.offset(),a=e('<div class="ui-effects-transfer"></div>').appendTo(document.body).addClass(t.options.className).css({top:u.top,left:u.left,height:n.innerHeight(),width:n.innerWidth(),position:"absolute"}).animate(s,t.duration,t.options.easing,function(){a.remove(),t.callback&&t.callback.apply(n[0],arguments),n.dequeue()})})}}(jQuery),function(e,t){e.widget("ui.accordion",{options:{active:0,animated:"slide",autoHeight:!0,clearStyle:!1,collapsible:!1,event:"click",fillSpace:!1,header:"> li > :first-child,> :not(li):even",icons:{header:"ui-icon-triangle-1-e",headerSelected:"ui-icon-triangle-1-s"},navigation:!1,navigationFilter:function(){return this.href.toLowerCase()===location.href.toLowerCase()}},_create:function(){var t=this,n=t.options;t.running=0,t.element.addClass("ui-accordion ui-widget ui-helper-reset").children("li").addClass("ui-accordion-li-fix"),t.headers=t.element.find(n.header).addClass("ui-accordion-header ui-helper-reset ui-state-default ui-corner-all").bind("mouseenter.accordion",function(){if(n.disabled)return;e(this).addClass("ui-state-hover")}).bind("mouseleave.accordion",function(){if(n.disabled)return;e(this).removeClass("ui-state-hover")}).bind("focus.accordion",function(){if(n.disabled)return;e(this).addClass("ui-state-focus")}).bind("blur.accordion",function(){if(n.disabled)return;e(this).removeClass("ui-state-focus")}),t.headers.next().addClass("ui-accordion-content ui-helper-reset ui-widget-content ui-corner-bottom");if(n.navigation){var r=t.element.find("a").filter(n.navigationFilter).eq(0);if(r.length){var i=r.closest(".ui-accordion-header");i.length?t.active=i:t.active=r.closest(".ui-accordion-content").prev()}}t.active=t._findActive(t.active||n.active).addClass("ui-state-default ui-state-active").toggleClass("ui-corner-all").toggleClass("ui-corner-top"),t.active.next().addClass("ui-accordion-content-active"),t._createIcons(),t.resize(),t.element.attr("role","tablist"),t.headers.attr("role","tab").bind("keydown.accordion",function(e){return t._keydown(e)}).next().attr("role","tabpanel"),t.headers.not(t.active||"").attr({"aria-expanded":"false","aria-selected":"false",tabIndex:-1}).next().hide(),t.active.length?t.active.attr({"aria-expanded":"true","aria-selected":"true",tabIndex:0}):t.headers.eq(0).attr("tabIndex",0),e.browser.safari||t.headers.find("a").attr("tabIndex",-1),n.event&&t.headers.bind(n.event.split(" ").join(".accordion ")+".accordion",function(e){t._clickHandler.call(t,e,this),e.preventDefault()})},_createIcons:function(){var t=this.options;t.icons&&(e("<span></span>").addClass("ui-icon "+t.icons.header).prependTo(this.headers),this.active.children(".ui-icon").toggleClass(t.icons.header).toggleClass(t.icons.headerSelected),this.element.addClass("ui-accordion-icons"))},_destroyIcons:function(){this.headers.children(".ui-icon").remove(),this.element.removeClass("ui-accordion-icons")},destroy:function(){var t=this.options;this.element.removeClass("ui-accordion ui-widget ui-helper-reset").removeAttr("role"),this.headers.unbind(".accordion").removeClass("ui-accordion-header ui-accordion-disabled ui-helper-reset ui-state-default ui-corner-all ui-state-active ui-state-disabled ui-corner-top").removeAttr("role").removeAttr("aria-expanded").removeAttr("aria-selected").removeAttr("tabIndex"),this.headers.find("a").removeAttr("tabIndex"),this._destroyIcons();var n=this.headers.next().css("display","").removeAttr("role").removeClass("ui-helper-reset ui-widget-content ui-corner-bottom ui-accordion-content ui-accordion-content-active ui-accordion-disabled ui-state-disabled");return(t.autoHeight||t.fillHeight)&&n.css("height",""),e.Widget.prototype.destroy.call(this)},_setOption:function(t,n){e.Widget.prototype._setOption.apply(this,arguments),t=="active"&&this.activate(n),t=="icons"&&(this._destroyIcons(),n&&this._createIcons()),t=="disabled"&&this.headers.add(this.headers.next())[n?"addClass":"removeClass"]("ui-accordion-disabled ui-state-disabled")},_keydown:function(t){if(this.options.disabled||t.altKey||t.ctrlKey)return;var n=e.ui.keyCode,r=this.headers.length,i=this.headers.index(t.target),s=!1;switch(t.keyCode){case n.RIGHT:case n.DOWN:s=this.headers[(i+1)%r];break;case n.LEFT:case n.UP:s=this.headers[(i-1+r)%r];break;case n.SPACE:case n.ENTER:this._clickHandler({target:t.target},t.target),t.preventDefault()}return s?(e(t.target).attr("tabIndex",-1),e(s).attr("tabIndex",0),s.focus(),!1):!0},resize:function(){var t=this.options,n;if(t.fillSpace){if(e.browser.msie){var r=this.element.parent().css("overflow");this.element.parent().css("overflow","hidden")}n=this.element.parent().height(),e.browser.msie&&this.element.parent().css("overflow",r),this.headers.each(function(){n-=e(this).outerHeight(!0)}),this.headers.next().each(function(){e(this).height(Math.max(0,n-e(this).innerHeight()+e(this).height()))}).css("overflow","auto")}else t.autoHeight&&(n=0,this.headers.next().each(function(){n=Math.max(n,e(this).height("").height())}).height(n));return this},activate:function(e){this.options.active=e;var t=this._findActive(e)[0];return this._clickHandler({target:t},t),this},_findActive:function(t){return t?typeof t=="number"?this.headers.filter(":eq("+t+")"):this.headers.not(this.headers.not(t)):t===!1?e([]):this.headers.filter(":eq(0)")},_clickHandler:function(t,n){var r=this.options;if(r.disabled)return;if(!t.target){if(!r.collapsible)return;this.active.removeClass("ui-state-active ui-corner-top").addClass("ui-state-default ui-corner-all").children(".ui-icon").removeClass(r.icons.headerSelected).addClass(r.icons.header),this.active.next().addClass("ui-accordion-content-active");var i=this.active.next(),s={options:r,newHeader:e([]),oldHeader:r.active,newContent:e([]),oldContent:i},o=this.active=e([]);this._toggle(o,i,s);return}var u=e(t.currentTarget||n),a=u[0]===this.active[0];r.active=r.collapsible&&a?!1:this.headers.index(u);if(this.running||!r.collapsible&&a)return;var f=this.active,o=u.next(),i=this.active.next(),s={options:r,newHeader:a&&r.collapsible?e([]):u,oldHeader:this.active,newContent:a&&r.collapsible?e([]):o,oldContent:i},l=this.headers.index(this.active[0])>this.headers.index(u[0]);this.active=a?e([]):u,this._toggle(o,i,s,a,l),f.removeClass("ui-state-active ui-corner-top").addClass("ui-state-default ui-corner-all").children(".ui-icon").removeClass(r.icons.headerSelected).addClass(r.icons.header),a||(u.removeClass("ui-state-default ui-corner-all").addClass("ui-state-active ui-corner-top").children(".ui-icon").removeClass(r.icons.header).addClass(r.icons.headerSelected),u.next().addClass("ui-accordion-content-active"));return},_toggle:function(t,n,r,i,s){var o=this,u=o.options;o.toShow=t,o.toHide=n,o.data=r;var a=function(){if(!o)return;return o._completed.apply(o,arguments)};o._trigger("changestart",null,o.data),o.running=n.size()===0?t.size():n.size();if(u.animated){var f={};u.collapsible&&i?f={toShow:e([]),toHide:n,complete:a,down:s,autoHeight:u.autoHeight||u.fillSpace}:f={toShow:t,toHide:n,complete:a,down:s,autoHeight:u.autoHeight||u.fillSpace},u.proxied||(u.proxied=u.animated),u.proxiedDuration||(u.proxiedDuration=u.duration),u.animated=e.isFunction(u.proxied)?u.proxied(f):u.proxied,u.duration=e.isFunction(u.proxiedDuration)?u.proxiedDuration(f):u.proxiedDuration;var l=e.ui.accordion.animations,c=u.duration,h=u.animated;h&&!l[h]&&!e.easing[h]&&(h="slide"),l[h]||(l[h]=function(e){this.slide(e,{easing:h,duration:c||700})}),l[h](f)}else u.collapsible&&i?t.toggle():(n.hide(),t.show()),a(!0);n.prev().attr({"aria-expanded":"false","aria-selected":"false",tabIndex:-1}).blur(),t.prev().attr({"aria-expanded":"true","aria-selected":"true",tabIndex:0}).focus()},_completed:function(e){this.running=e?0:--this.running;if(this.running)return;this.options.clearStyle&&this.toShow.add(this.toHide).css({height:"",overflow:""}),this.toHide.removeClass("ui-accordion-content-active"),this.toHide.length&&(this.toHide.parent()[0].className=this.toHide.parent()[0].className),this._trigger("change",null,this.data)}}),e.extend(e.ui.accordion,{version:"@VERSION",animations:{slide:function(t,n){t=e.extend({easing:"swing",duration:300},t,n);if(!t.toHide.size()){t.toShow.animate({height:"show",paddingTop:"show",paddingBottom:"show"},t);return}if(!t.toShow.size()){t.toHide.animate({height:"hide",paddingTop:"hide",paddingBottom:"hide"},t);return}var r=t.toShow.css("overflow"),i=0,s={},o={},u=["height","paddingTop","paddingBottom"],a,f=t.toShow;a=f[0].style.width,f.width(f.parent().width()-parseFloat(f.css("paddingLeft"))-parseFloat(f.css("paddingRight"))-(parseFloat(f.css("borderLeftWidth"))||0)-(parseFloat(f.css("borderRightWidth"))||0)),e.each(u,function(n,r){o[r]="hide";var i=(""+e.css(t.toShow[0],r)).match(/^([\d+-.]+)(.*)$/);s[r]={value:i[1],unit:i[2]||"px"}}),t.toShow.css({height:0,overflow:"hidden"}).show(),t.toHide.filter(":hidden").each(t.complete).end().filter(":visible").animate(o,{step:function(e,n){n.prop=="height"&&(i=n.end-n.start===0?0:(n.now-n.start)/(n.end-n.start)),t.toShow[0].style[n.prop]=i*s[n.prop].value+s[n.prop].unit},duration:t.duration,easing:t.easing,complete:function(){t.autoHeight||t.toShow.css("height",""),t.toShow.css({width:a,overflow:r}),t.complete()}})},bounceslide:function(e){this.slide(e,{easing:e.down?"easeOutBounce":"swing",duration:e.down?1e3:200})}}})}(jQuery),function(e,t){var n=0;e.widget("ui.autocomplete",{options:{appendTo:"body",autoFocus:!1,delay:300,minLength:1,position:{my:"left top",at:"left bottom",collision:"none"},source:null},pending:0,_create:function(){var t=this,n=this.element[0].ownerDocument,r;this.isMultiLine=this.element.is("textarea"),this.element.addClass("ui-autocomplete-input").attr("autocomplete","off").attr({role:"textbox","aria-autocomplete":"list","aria-haspopup":"true"}).bind("keydown.autocomplete",function(n){if(t.options.disabled||t.element.propAttr("readOnly"))return;r=!1;var i=e.ui.keyCode;switch(n.keyCode){case i.PAGE_UP:t._move("previousPage",n);break;case i.PAGE_DOWN:t._move("nextPage",n);break;case i.UP:t._keyEvent("previous",n);break;case i.DOWN:t._keyEvent("next",n);break;case i.ENTER:case i.NUMPAD_ENTER:t.menu.active&&(r=!0,n.preventDefault());case i.TAB:if(!t.menu.active)return;t.menu.select(n);break;case i.ESCAPE:t.element.val(t.term),t.close(n);break;default:clearTimeout(t.searching),t.searching=setTimeout(function(){t.term!=t.element.val()&&(t.selectedItem=null,t.search(null,n))},t.options.delay)}}).bind("keypress.autocomplete",function(e){r&&(r=!1,e.preventDefault())}).bind("focus.autocomplete",function(){if(t.options.disabled)return;t.selectedItem=null,t.previous=t.element.val()}).bind("blur.autocomplete",function(e){if(t.options.disabled)return;clearTimeout(t.searching),t.closing=setTimeout(function(){t.close(e),t._change(e)},150)}),this._initSource(),this.menu=e("<ul></ul>").addClass("ui-autocomplete").appendTo(e(this.options.appendTo||"body",n)[0]).mousedown(function(n){var r=t.menu.element[0];e(n.target).closest(".ui-menu-item").length||setTimeout(function(){e(document).one("mousedown",function(n){n.target!==t.element[0]&&n.target!==r&&!e.ui.contains(r,n.target)&&t.close()})},1),setTimeout(function(){clearTimeout(t.closing)},13)}).menu({focus:function(e,n){var r=n.item.data("item.autocomplete");!1!==t._trigger("focus",e,{item:r})&&/^key/.test(e.originalEvent.type)&&t.element.val(r.value)},selected:function(e,r){var i=r.item.data("item.autocomplete"),s=t.previous;t.element[0]!==n.activeElement&&(t.element.focus(),t.previous=s,setTimeout(function(){t.previous=s,t.selectedItem=i},1)),!1!==t._trigger("select",e,{item:i})&&t.element.val(i.value),t.term=t.element.val(),t.close(e),t.selectedItem=i},blur:function(e,n){t.menu.element.is(":visible")&&t.element.val()!==t.term&&t.element.val(t.term)}}).zIndex(this.element.zIndex()+1).css({top:0,left:0}).hide().data("menu"),e.fn.bgiframe&&this.menu.element.bgiframe(),t.beforeunloadHandler=function(){t.element.removeAttr("autocomplete")},e(window).bind("beforeunload",t.beforeunloadHandler)},destroy:function(){this.element.removeClass("ui-autocomplete-input").removeAttr("autocomplete").removeAttr("role").removeAttr("aria-autocomplete").removeAttr("aria-haspopup"),this.menu.element.remove(),e(window).unbind("beforeunload",this.beforeunloadHandler),e.Widget.prototype.destroy.call(this)},_setOption:function(t,n){e.Widget.prototype._setOption.apply(this,arguments),t==="source"&&this._initSource(),t==="appendTo"&&this.menu.element.appendTo(e(n||"body",this.element[0].ownerDocument)[0]),t==="disabled"&&n&&this.xhr&&this.xhr.abort()},_initSource:function(){var t=this,n,r;e.isArray(this.options.source)?(n=this.options.source,this.source=function(t,r){r(e.ui.autocomplete.filter(n,t.term))}):typeof this.options.source=="string"?(r=this.options.source,this.source=function(n,i){t.xhr&&t.xhr.abort(),t.xhr=e.ajax({url:r,data:n,dataType:"json",success:function(e,t){i(e)},error:function(){i([])}})}):this.source=this.options.source},search:function(e,t){e=e!=null?e:this.element.val(),this.term=this.element.val();if(e.length<this.options.minLength)return this.close(t);clearTimeout(this.closing);if(this._trigger("search",t)===!1)return;return this._search(e)},_search:function(e){this.pending++,this.element.addClass("ui-autocomplete-loading"),this.source({term:e},this._response())},_response:function(){var e=this,t=++n;return function(r){t===n&&e.__response(r),e.pending--,e.pending||e.element.removeClass("ui-autocomplete-loading")}},__response:function(e){!this.options.disabled&&e&&e.length?(e=this._normalize(e),this._suggest(e),this._trigger("open")):this.close()},close:function(e){clearTimeout(this.closing),this.menu.element.is(":visible")&&(this.menu.element.hide(),this.menu.deactivate(),this._trigger("close",e))},_change:function(e){this.previous!==this.element.val()&&this._trigger("change",e,{item:this.selectedItem})},_normalize:function(t){return t.length&&t[0].label&&t[0].value?t:e.map(t,function(t){return typeof t=="string"?{label:t,value:t}:e.extend({label:t.label||t.value,value:t.value||t.label},t)})},_suggest:function(t){var n=this.menu.element.empty().zIndex(this.element.zIndex()+1);this._renderMenu(n,t),this.menu.deactivate(),this.menu.refresh(),n.show(),this._resizeMenu(),n.position(e.extend({of:this.element},this.options.position)),this.options.autoFocus&&this.menu.next(new e.Event("mouseover"))},_resizeMenu:function(){var e=this.menu.element;e.outerWidth(Math.max(e.width("").outerWidth()+1,this.element.outerWidth()))},_renderMenu:function(t,n){var r=this;e.each(n,function(e,n){r._renderItem(t,n)})},_renderItem:function(t,n){return e("<li></li>").data("item.autocomplete",n).append(e("<a></a>").text(n.label)).appendTo(t)},_move:function(e,t){if(!this.menu.element.is(":visible")){this.search(null,t);return}if(this.menu.first()&&/^previous/.test(e)||this.menu.last()&&/^next/.test(e)){this.element.val(this.term),this.menu.deactivate();return}this.menu[e](t)},widget:function(){return this.menu.element},_keyEvent:function(e,t){if(!this.isMultiLine||this.menu.element.is(":visible"))this._move(e,t),t.preventDefault()}}),e.extend(e.ui.autocomplete,{escapeRegex:function(e){return e.replace(/[-[\]{}()*+?.,\\^$|#\s]/g,"\\$&")},filter:function(t,n){var r=new RegExp(e.ui.autocomplete.escapeRegex(n),"i");return e.grep(t,function(e){return r.test(e.label||e.value||e)})}})}(jQuery),function(e){e.widget("ui.menu",{_create:function(){var t=this;this.element.addClass("ui-menu ui-widget ui-widget-content ui-corner-all").attr({role:"listbox","aria-activedescendant":"ui-active-menuitem"}).click(function(n){if(!e(n.target).closest(".ui-menu-item a").length)return;n.preventDefault(),t.select(n)}),this.refresh()},refresh:function(){var t=this,n=this.element.children("li:not(.ui-menu-item):has(a)").addClass("ui-menu-item").attr("role","menuitem");n.children("a").addClass("ui-corner-all").attr("tabindex",-1).mouseenter(function(n){t.activate(n,e(this).parent())}).mouseleave(function(){t.deactivate()})},activate:function(e,t){this.deactivate();if(this.hasScroll()){var n=t.offset().top-this.element.offset().top,r=this.element.scrollTop(),i=this.element.height();n<0?this.element.scrollTop(r+n):n>=i&&this.element.scrollTop(r+n-i+t.height())}this.active=t.eq(0).children("a").addClass("ui-state-hover").attr("id","ui-active-menuitem").end(),this._trigger("focus",e,{item:t})},deactivate:function(){if(!this.active)return;this.active.children("a").removeClass("ui-state-hover").removeAttr("id"),this._trigger("blur"),this.active=null},next:function(e){this.move("next",".ui-menu-item:first",e)},previous:function(e){this.move("prev",".ui-menu-item:last",e)},first:function(){return this.active&&!this.active.prevAll(".ui-menu-item").length},last:function(){return this.active&&!this.active.nextAll(".ui-menu-item").length},move:function(e,t,n){if(!this.active){this.activate(n,this.element.children(t));return}var r=this.active[e+"All"](".ui-menu-item").eq(0);r.length?this.activate(n,r):this.activate(n,this.element.children(t))},nextPage:function(t){if(this.hasScroll()){if(!this.active||this.last()){this.activate(t,this.element.children(".ui-menu-item:first"));return}var n=this.active.offset().top,r=this.element.height(),i=this.element.children(".ui-menu-item").filter(function(){var t=e(this).offset().top-n-r+e(this).height();return t<10&&t>-10});i.length||(i=this.element.children(".ui-menu-item:last")),this.activate(t,i)}else this.activate(t,this.element.children(".ui-menu-item").filter(!this.active||this.last()?":first":":last"))},previousPage:function(t){if(this.hasScroll()){if(!this.active||this.first()){this.activate(t,this.element.children(".ui-menu-item:last"));return}var n=this.active.offset().top,r=this.element.height(),i=this.element.children(".ui-menu-item").filter(function(){var t=e(this).offset().top-n+r-e(this).height();return t<10&&t>-10});i.length||(i=this.element.children(".ui-menu-item:first")),this.activate(t,i)}else this.activate(t,this.element.children(".ui-menu-item").filter(!this.active||this.first()?":last":":first"))},hasScroll:function(){return this.element.height()<this.element[e.fn.prop?"prop":"attr"]("scrollHeight")},select:function(e){this._trigger("selected",e,{item:this.active})}})}(jQuery),function(e,t){var n,r,i,s,o="ui-button ui-widget ui-state-default ui-corner-all",u="ui-state-hover ui-state-active ",a="ui-button-icons-only ui-button-icon-only ui-button-text-icons ui-button-text-icon-primary ui-button-text-icon-secondary ui-button-text-only",f=function(){var t=e(this).find(":ui-button");setTimeout(function(){t.button("refresh")},1)},l=function(t){var n=t.name,r=t.form,i=e([]);return n&&(r?i=e(r).find("[name='"+n+"']"):i=e("[name='"+n+"']",t.ownerDocument).filter(function(){return!this.form})),i};e.widget("ui.button",{options:{disabled:null,text:!0,label:null,icons:{primary:null,secondary:null}},_create:function(){this.element.closest("form").unbind("reset.button").bind("reset.button",f),typeof this.options.disabled!="boolean"?this.options.disabled=!!this.element.propAttr("disabled"):this.element.propAttr("disabled",this.options.disabled),this._determineButtonType(),this.hasTitle=!!this.buttonElement.attr("title");var t=this,u=this.options,a=this.type==="checkbox"||this.type==="radio",c="ui-state-hover"+(a?"":" ui-state-active"),h="ui-state-focus";u.label===null&&(u.label=this.buttonElement.html()),this.buttonElement.addClass(o).attr("role","button").bind("mouseenter.button",function(){if(u.disabled)return;e(this).addClass("ui-state-hover"),this===n&&e(this).addClass("ui-state-active")}).bind("mouseleave.button",function(){if(u.disabled)return;e(this).removeClass(c)}).bind("click.button",function(e){u.disabled&&(e.preventDefault(),e.stopImmediatePropagation())}),this.element.bind("focus.button",function(){t.buttonElement.addClass(h)}).bind("blur.button",function(){t.buttonElement.removeClass(h)}),a&&(this.element.bind("change.button",function(){if(s)return;t.refresh()}),this.buttonElement.bind("mousedown.button",function(e){if(u.disabled)return;s=!1,r=e.pageX,i=e.pageY}).bind("mouseup.button",function(e){if(u.disabled)return;if(r!==e.pageX||i!==e.pageY)s=!0})),this.type==="checkbox"?this.buttonElement.bind("click.button",function(){if(u.disabled||s)return!1;e(this).toggleClass("ui-state-active"),t.buttonElement.attr("aria-pressed",t.element[0].checked)}):this.type==="radio"?this.buttonElement.bind("click.button",function(){if(u.disabled||s)return!1;e(this).addClass("ui-state-active"),t.buttonElement.attr("aria-pressed","true");var n=t.element[0];l(n).not(n).map(function(){return e(this).button("widget")[0]}).removeClass("ui-state-active").attr("aria-pressed","false")}):(this.buttonElement.bind("mousedown.button",function(){if(u.disabled)return!1;e(this).addClass("ui-state-active"),n=this,e(document).one("mouseup",function(){n=null})}).bind("mouseup.button",function(){if(u.disabled)return!1;e(this).removeClass("ui-state-active")}).bind("keydown.button",function(t){if(u.disabled)return!1;(t.keyCode==e.ui.keyCode.SPACE||t.keyCode==e.ui.keyCode.ENTER)&&e(this).addClass("ui-state-active")}).bind("keyup.button",function(){e(this).removeClass("ui-state-active")}),this.buttonElement.is("a")&&this.buttonElement.keyup(function(t){t.keyCode===e.ui.keyCode.SPACE&&e(this).click()})),this._setOption("disabled",u.disabled),this._resetButton()},_determineButtonType:function(){this.element.is(":checkbox")?this.type="checkbox":this.element.is(":radio")?this.type="radio":this.element.is("input")?this.type="input":this.type="button";if(this.type==="checkbox"||this.type==="radio"){var e=this.element.parents().filter(":last"),t="label[for='"+this.element.attr("id")+"']";this.buttonElement=e.find(t),this.buttonElement.length||(e=e.length?e.siblings():this.element.siblings(),this.buttonElement=e.filter(t),this.buttonElement.length||(this.buttonElement=e.find(t))),this.element.addClass("ui-helper-hidden-accessible");var n=this.element.is(":checked");n&&this.buttonElement.addClass("ui-state-active"),this.buttonElement.attr("aria-pressed",n)}else this.buttonElement=this.element},widget:function(){return this.buttonElement},destroy:function(){this.element.removeClass("ui-helper-hidden-accessible"),this.buttonElement.removeClass(o+" "+u+" "+a).removeAttr("role").removeAttr("aria-pressed").html(this.buttonElement.find(".ui-button-text").html()),this.hasTitle||this.buttonElement.removeAttr("title"),e.Widget.prototype.destroy.call(this)},_setOption:function(t,n){e.Widget.prototype._setOption.apply(this,arguments);if(t==="disabled"){n?this.element.propAttr("disabled",!0):this.element.propAttr("disabled",!1);return}this._resetButton()},refresh:function(){var t=this.element.is(":disabled");t!==this.options.disabled&&this._setOption("disabled",t),this.type==="radio"?l(this.element[0]).each(function(){e(this).is(":checked")?e(this).button("widget").addClass("ui-state-active").attr("aria-pressed","true"):e(this).button("widget").removeClass("ui-state-active").attr("aria-pressed","false")}):this.type==="checkbox"&&(this.element.is(":checked")?this.buttonElement.addClass("ui-state-active").attr("aria-pressed","true"):this.buttonElement.removeClass("ui-state-active").attr("aria-pressed","false"))},_resetButton:function(){if(this.type==="input"){this.options.label&&this.element.val(this.options.label);return}var t=this.buttonElement.removeClass(a),n=e("<span></span>",this.element[0].ownerDocument).addClass("ui-button-text").html(this.options.label).appendTo(t.empty()).text(),r=this.options.icons,i=r.primary&&r.secondary,s=[];r.primary||r.secondary?(this.options.text&&s.push("ui-button-text-icon"+(i?"s":r.primary?"-primary":"-secondary")),r.primary&&t.prepend("<span class='ui-button-icon-primary ui-icon "+r.primary+"'></span>"),r.secondary&&t.append("<span class='ui-button-icon-secondary ui-icon "+r.secondary+"'></span>"),this.options.text||(s.push(i?"ui-button-icons-only":"ui-button-icon-only"),this.hasTitle||t.attr("title",n))):s.push("ui-button-text-only"),t.addClass(s.join(" "))}}),e.widget("ui.buttonset",{options:{items:":button, :submit, :reset, :checkbox, :radio, a, :data(button)"},_create:function(){this.element.addClass("ui-buttonset")},_init:function(){this.refresh()},_setOption:function(t,n){t==="disabled"&&this.buttons.button("option",t,n),e.Widget.prototype._setOption.apply(this,arguments)},refresh:function(){var t=this.element.css("direction")==="rtl";this.buttons=this.element.find(this.options.items).filter(":ui-button").button("refresh").end().not(":ui-button").button().end().map(function(){return e(this).button("widget")[0]}).removeClass("ui-corner-all ui-corner-left ui-corner-right").filter(":first").addClass(t?"ui-corner-right":"ui-corner-left").end().filter(":last").addClass(t?"ui-corner-left":"ui-corner-right").end().end()},destroy:function(){this.element.removeClass("ui-buttonset"),this.buttons.map(function(){return e(this).button("widget")[0]}).removeClass("ui-corner-left ui-corner-right").end().button("destroy"),e.Widget.prototype.destroy.call(this)}})}(jQuery),function($,undefined){function Datepicker(){this.debug=!1,this._curInst=null,this._keyEvent=!1,this._disabledInputs=[],this._datepickerShowing=!1,this._inDialog=!1,this._mainDivId="ui-datepicker-div",this._inlineClass="ui-datepicker-inline",this._appendClass="ui-datepicker-append",this._triggerClass="ui-datepicker-trigger",this._dialogClass="ui-datepicker-dialog",this._disableClass="ui-datepicker-disabled",this._unselectableClass="ui-datepicker-unselectable",this._currentClass="ui-datepicker-current-day",this._dayOverClass="ui-datepicker-days-cell-over",this.regional=[],this.regional[""]={closeText:"Done",prevText:"Prev",nextText:"Next",currentText:"Today",monthNames:["January","February","March","April","May","June","July","August","September","October","November","December"],monthNamesShort:["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],dayNames:["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],dayNamesShort:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"],dayNamesMin:["Su","Mo","Tu","We","Th","Fr","Sa"],weekHeader:"Wk",dateFormat:"mm/dd/yy",firstDay:0,isRTL:!1,showMonthAfterYear:!1,yearSuffix:""},this._defaults={showOn:"focus",showAnim:"fadeIn",showOptions:{},defaultDate:null,appendText:"",buttonText:"...",buttonImage:"",buttonImageOnly:!1,hideIfNoPrevNext:!1,navigationAsDateFormat:!1,gotoCurrent:!1,changeMonth:!1,changeYear:!1,yearRange:"c-10:c+10",showOtherMonths:!1,selectOtherMonths:!1,showWeek:!1,calculateWeek:this.iso8601Week,shortYearCutoff:"+10",minDate:null,maxDate:null,duration:"fast",beforeShowDay:null,beforeShow:null,onSelect:null,onChangeMonthYear:null,onClose:null,numberOfMonths:1,showCurrentAtPos:0,stepMonths:1,stepBigMonths:12,altField:"",altFormat:"",constrainInput:!0,showButtonPanel:!1,autoSize:!1,disabled:!1},$.extend(this._defaults,this.regional[""]),this.dpDiv=bindHover($('<div id="'+this._mainDivId+'" class="ui-datepicker ui-widget ui-widget-content ui-helper-clearfix ui-corner-all"></div>'))}function bindHover(e){var t="button, .ui-datepicker-prev, .ui-datepicker-next, .ui-datepicker-calendar td a";return e.bind("mouseout",function(e){var n=$(e.target).closest(t);if(!n.length)return;n.removeClass("ui-state-hover ui-datepicker-prev-hover ui-datepicker-next-hover")}).bind("mouseover",function(n){var r=$(n.target).closest(t);if($.datepicker._isDisabledDatepicker(instActive.inline?e.parent()[0]:instActive.input[0])||!r.length)return;r.parents(".ui-datepicker-calendar").find("a").removeClass("ui-state-hover"),r.addClass("ui-state-hover"),r.hasClass("ui-datepicker-prev")&&r.addClass("ui-datepicker-prev-hover"),r.hasClass("ui-datepicker-next")&&r.addClass("ui-datepicker-next-hover")})}function extendRemove(e,t){$.extend(e,t);for(var n in t)if(t[n]==null||t[n]==undefined)e[n]=t[n];return e}function isArray(e){return e&&($.browser.safari&&typeof e=="object"&&e.length||e.constructor&&e.constructor.toString().match(/\Array\(\)/))}$.extend($.ui,{datepicker:{version:"@VERSION"}});var PROP_NAME="datepicker",dpuuid=(new Date).getTime(),instActive;$.extend(Datepicker.prototype,{markerClassName:"hasDatepicker",maxRows:4,log:function(){this.debug&&console.log.apply("",arguments)},_widgetDatepicker:function(){return this.dpDiv},setDefaults:function(e){return extendRemove(this._defaults,e||{}),this},_attachDatepicker:function(target,settings){var inlineSettings=null;for(var attrName in this._defaults){var attrValue=target.getAttribute("date:"+attrName);if(attrValue){inlineSettings=inlineSettings||{};try{inlineSettings[attrName]=eval(attrValue)}catch(err){inlineSettings[attrName]=attrValue}}}var nodeName=target.nodeName.toLowerCase(),inline=nodeName=="div"||nodeName=="span";target.id||(this.uuid+=1,target.id="dp"+this.uuid);var inst=this._newInst($(target),inline);inst.settings=$.extend({},settings||{},inlineSettings||{}),nodeName=="input"?this._connectDatepicker(target,inst):inline&&this._inlineDatepicker(target,inst)},_newInst:function(e,t){var n=e[0].id.replace(/([^A-Za-z0-9_-])/g,"\\\\$1");return{id:n,input:e,selectedDay:0,selectedMonth:0,selectedYear:0,drawMonth:0,drawYear:0,inline:t,dpDiv:t?bindHover($('<div class="'+this._inlineClass+' ui-datepicker ui-widget ui-widget-content ui-helper-clearfix ui-corner-all"></div>')):this.dpDiv}},_connectDatepicker:function(e,t){var n=$(e);t.append=$([]),t.trigger=$([]);if(n.hasClass(this.markerClassName))return;this._attachments(n,t),n.addClass(this.markerClassName).keydown(this._doKeyDown).keypress(this._doKeyPress).keyup(this._doKeyUp).bind("setData.datepicker",function(e,n,r){t.settings[n]=r}).bind("getData.datepicker",function(e,n){return this._get(t,n)}),this._autoSize(t),$.data(e,PROP_NAME,t),t.settings.disabled&&this._disableDatepicker(e)},_attachments:function(e,t){var n=this._get(t,"appendText"),r=this._get(t,"isRTL");t.append&&t.append.remove(),n&&(t.append=$('<span class="'+this._appendClass+'">'+n+"</span>"),e[r?"before":"after"](t.append)),e.unbind("focus",this._showDatepicker),t.trigger&&t.trigger.remove();var i=this._get(t,"showOn");(i=="focus"||i=="both")&&e.focus(this._showDatepicker);if(i=="button"||i=="both"){var s=this._get(t,"buttonText"),o=this._get(t,"buttonImage");t.trigger=$(this._get(t,"buttonImageOnly")?$("<img/>").addClass(this._triggerClass).attr({src:o,alt:s,title:s}):$('<button type="button"></button>').addClass(this._triggerClass).html(o==""?s:$("<img/>").attr({src:o,alt:s,title:s}))),e[r?"before":"after"](t.trigger),t.trigger.click(function(){return $.datepicker._datepickerShowing&&$.datepicker._lastInput==e[0]?$.datepicker._hideDatepicker():$.datepicker._datepickerShowing&&$.datepicker._lastInput!=e[0]?($.datepicker._hideDatepicker(),$.datepicker._showDatepicker(e[0])):$.datepicker._showDatepicker(e[0]),!1})}},_autoSize:function(e){if(this._get(e,"autoSize")&&!e.inline){var t=new Date(2009,11,20),n=this._get(e,"dateFormat");if(n.match(/[DM]/)){var r=function(e){var t=0,n=0;for(var r=0;r<e.length;r++)e[r].length>t&&(t=e[r].length,n=r);return n};t.setMonth(r(this._get(e,n.match(/MM/)?"monthNames":"monthNamesShort"))),t.setDate(r(this._get(e,n.match(/DD/)?"dayNames":"dayNamesShort"))+20-t.getDay())}e.input.attr("size",this._formatDate(e,t).length)}},_inlineDatepicker:function(e,t){var n=$(e);if(n.hasClass(this.markerClassName))return;n.addClass(this.markerClassName).append(t.dpDiv).bind("setData.datepicker",function(e,n,r){t.settings[n]=r}).bind("getData.datepicker",function(e,n){return this._get(t,n)}),$.data(e,PROP_NAME,t),this._setDate(t,this._getDefaultDate(t),!0),this._updateDatepicker(t),this._updateAlternate(t),t.settings.disabled&&this._disableDatepicker(e),t.dpDiv.css("display","block")},_dialogDatepicker:function(e,t,n,r,i){var s=this._dialogInst;if(!s){this.uuid+=1;var o="dp"+this.uuid;this._dialogInput=$('<input type="text" id="'+o+'" style="position: absolute; top: -100px; width: 0px; z-index: -10;"/>'),this._dialogInput.keydown(this._doKeyDown),$("body").append(this._dialogInput),s=this._dialogInst=this._newInst(this._dialogInput,!1),s.settings={},$.data(this._dialogInput[0],PROP_NAME,s)}extendRemove(s.settings,r||{}),t=t&&t.constructor==Date?this._formatDate(s,t):t,this._dialogInput.val(t),this._pos=i?i.length?i:[i.pageX,i.pageY]:null;if(!this._pos){var u=document.documentElement.clientWidth,a=document.documentElement.clientHeight,f=document.documentElement.scrollLeft||document.body.scrollLeft,l=document.documentElement.scrollTop||document.body.scrollTop;this._pos=[u/2-100+f,a/2-150+l]}return this._dialogInput.css("left",this._pos[0]+20+"px").css("top",this._pos[1]+"px"),s.settings.onSelect=n,this._inDialog=!0,this.dpDiv.addClass(this._dialogClass),this._showDatepicker(this._dialogInput[0]),$.blockUI&&$.blockUI(this.dpDiv),$.data(this._dialogInput[0],PROP_NAME,s),this},_destroyDatepicker:function(e){var t=$(e),n=$.data(e,PROP_NAME);if(!t.hasClass(this.markerClassName))return;var r=e.nodeName.toLowerCase();$.removeData(e,PROP_NAME),r=="input"?(n.append.remove(),n.trigger.remove(),t.removeClass(this.markerClassName).unbind("focus",this._showDatepicker).unbind("keydown",this._doKeyDown).unbind("keypress",this._doKeyPress).unbind("keyup",this._doKeyUp)):(r=="div"||r=="span")&&t.removeClass(this.markerClassName).empty()},_enableDatepicker:function(e){var t=$(e),n=$.data(e,PROP_NAME);if(!t.hasClass(this.markerClassName))return;var r=e.nodeName.toLowerCase();if(r=="input")e.disabled=!1,n.trigger.filter("button").each(function(){this.disabled=!1}).end().filter("img").css({opacity:"1.0",cursor:""});else if(r=="div"||r=="span"){var i=t.children("."+this._inlineClass);i.children().removeClass("ui-state-disabled"),i.find("select.ui-datepicker-month, select.ui-datepicker-year").removeAttr("disabled")}this._disabledInputs=$.map(this._disabledInputs,function(t){return t==e?null:t})},_disableDatepicker:function(e){var t=$(e),n=$.data(e,PROP_NAME);if(!t.hasClass(this.markerClassName))return;var r=e.nodeName.toLowerCase();if(r=="input")e.disabled=!0,n.trigger.filter("button").each(function(){this.disabled=!0}).end().filter("img").css({opacity:"0.5",cursor:"default"});else if(r=="div"||r=="span"){var i=t.children("."+this._inlineClass);i.children().addClass("ui-state-disabled"),i.find("select.ui-datepicker-month, select.ui-datepicker-year").attr("disabled","disabled")}this._disabledInputs=$.map(this._disabledInputs,function(t){return t==e?null:t}),this._disabledInputs[this._disabledInputs.length]=e},_isDisabledDatepicker:function(e){if(!e)return!1;for(var t=0;t<this._disabledInputs.length;t++)if(this._disabledInputs[t]==e)return!0;return!1},_getInst:function(e){try{return $.data(e,PROP_NAME)}catch(t){throw"Missing instance data for this datepicker"}},_optionDatepicker:function(e,t,n){var r=this._getInst(e);if(arguments.length==2&&typeof t=="string")return t=="defaults"?$.extend({},$.datepicker._defaults):r?t=="all"?$.extend({},r.settings):this._get(r,t):null;var i=t||{};typeof t=="string"&&(i={},i[t]=n);if(r){this._curInst==r&&this._hideDatepicker();var s=this._getDateDatepicker(e,!0),o=this._getMinMaxDate(r,"min"),u=this._getMinMaxDate(r,"max");extendRemove(r.settings,i),o!==null&&i.dateFormat!==undefined&&i.minDate===undefined&&(r.settings.minDate=this._formatDate(r,o)),u!==null&&i.dateFormat!==undefined&&i.maxDate===undefined&&(r.settings.maxDate=this._formatDate(r,u)),this._attachments($(e),r),this._autoSize(r),this._setDate(r,s),this._updateAlternate(r),this._updateDatepicker(r)}},_changeDatepicker:function(e,t,n){this._optionDatepicker(e,t,n)},_refreshDatepicker:function(e){var t=this._getInst(e);t&&this._updateDatepicker(t)},_setDateDatepicker:function(e,t){var n=this._getInst(e);n&&(this._setDate(n,t),this._updateDatepicker(n),this._updateAlternate(n))},_getDateDatepicker:function(e,t){var n=this._getInst(e);return n&&!n.inline&&this._setDateFromField(n,t),n?this._getDate(n):null},_doKeyDown:function(e){var t=$.datepicker._getInst(e.target),n=!0,r=t.dpDiv.is(".ui-datepicker-rtl");t._keyEvent=!0;if($.datepicker._datepickerShowing)switch(e.keyCode){case 9:$.datepicker._hideDatepicker(),n=!1;break;case 13:var i=$("td."+$.datepicker._dayOverClass+":not(."+$.datepicker._currentClass+")",t.dpDiv);i[0]&&$.datepicker._selectDay(e.target,t.selectedMonth,t.selectedYear,i[0]);var s=$.datepicker._get(t,"onSelect");if(s){var o=$.datepicker._formatDate(t);s.apply(t.input?t.input[0]:null,[o,t])}else $.datepicker._hideDatepicker();return!1;case 27:$.datepicker._hideDatepicker();break;case 33:$.datepicker._adjustDate(e.target,e.ctrlKey?-$.datepicker._get(t,"stepBigMonths"):-$.datepicker._get(t,"stepMonths"),"M");break;case 34:$.datepicker._adjustDate(e.target,e.ctrlKey?+$.datepicker._get(t,"stepBigMonths"):+$.datepicker._get(t,"stepMonths"),"M");break;case 35:(e.ctrlKey||e.metaKey)&&$.datepicker._clearDate(e.target),n=e.ctrlKey||e.metaKey;break;case 36:(e.ctrlKey||e.metaKey)&&$.datepicker._gotoToday(e.target),n=e.ctrlKey||e.metaKey;break;case 37:(e.ctrlKey||e.metaKey)&&$.datepicker._adjustDate(e.target,r?1:-1,"D"),n=e.ctrlKey||e.metaKey,e.originalEvent.altKey&&$.datepicker._adjustDate(e.target,e.ctrlKey?-$.datepicker._get(t,"stepBigMonths"):-$.datepicker._get(t,"stepMonths"),"M");break;case 38:(e.ctrlKey||e.metaKey)&&$.datepicker._adjustDate(e.target,-7,"D"),n=e.ctrlKey||e.metaKey;break;case 39:(e.ctrlKey||e.metaKey)&&$.datepicker._adjustDate(e.target,r?-1:1,"D"),n=e.ctrlKey||e.metaKey,e.originalEvent.altKey&&$.datepicker._adjustDate(e.target,e.ctrlKey?+$.datepicker._get(t,"stepBigMonths"):+$.datepicker._get(t,"stepMonths"),"M");break;case 40:(e.ctrlKey||e.metaKey)&&$.datepicker._adjustDate(e.target,7,"D"),n=e.ctrlKey||e.metaKey;break;default:n=!1}else e.keyCode==36&&e.ctrlKey?$.datepicker._showDatepicker(this):n=!1;n&&(e.preventDefault(),e.stopPropagation())},_doKeyPress:function(e){var t=$.datepicker._getInst(e.target);if($.datepicker._get(t,"constrainInput")){var n=$.datepicker._possibleChars($.datepicker._get(t,"dateFormat")),r=String.fromCharCode(e.charCode==undefined?e.keyCode:e.charCode);return e.ctrlKey||e.metaKey||r<" "||!n||n.indexOf(r)>-1}},_doKeyUp:function(e){var t=$.datepicker._getInst(e.target);if(t.input.val()!=t.lastVal)try{var n=$.datepicker.parseDate($.datepicker._get(t,"dateFormat"),t.input?t.input.val():null,$.datepicker._getFormatConfig(t));n&&($.datepicker._setDateFromField(t),$.datepicker._updateAlternate(t),$.datepicker._updateDatepicker(t))}catch(r){$.datepicker.log(r)}return!0},_showDatepicker:function(e){e=e.target||e,e.nodeName.toLowerCase()!="input"&&(e=$("input",e.parentNode)[0]);if($.datepicker._isDisabledDatepicker(e)||$.datepicker._lastInput==e)return;var t=$.datepicker._getInst(e);$.datepicker._curInst&&$.datepicker._curInst!=t&&($.datepicker._curInst.dpDiv.stop(!0,!0),t&&$.datepicker._datepickerShowing&&$.datepicker._hideDatepicker($.datepicker._curInst.input[0]));var n=$.datepicker._get(t,"beforeShow"),r=n?n.apply(e,[e,t]):{};if(r===!1)return;extendRemove(t.settings,r),t.lastVal=null,$.datepicker._lastInput=e,$.datepicker._setDateFromField(t),$.datepicker._inDialog&&(e.value=""),$.datepicker._pos||($.datepicker._pos=$.datepicker._findPos(e),$.datepicker._pos[1]+=e.offsetHeight);var i=!1;$(e).parents().each(function(){return i|=$(this).css("position")=="fixed",!i}),i&&$.browser.opera&&($.datepicker._pos[0]-=document.documentElement.scrollLeft,$.datepicker._pos[1]-=document.documentElement.scrollTop);var s={left:$.datepicker._pos[0],top:$.datepicker._pos[1]};$.datepicker._pos=null,t.dpDiv.empty(),t.dpDiv.css({position:"absolute",display:"block",top:"-1000px"}),$.datepicker._updateDatepicker(t),s=$.datepicker._checkOffset(t,s,i),t.dpDiv.css({position:$.datepicker._inDialog&&$.blockUI?"static":i?"fixed":"absolute",display:"none",left:s.left+"px",top:s.top+"px"});if(!t.inline){var o=$.datepicker._get(t,"showAnim"),u=$.datepicker._get(t,"duration"),a=function(){var e=t.dpDiv.find("iframe.ui-datepicker-cover");if(!!e.length){var n=$.datepicker._getBorders(t.dpDiv);e.css({left:-n[0],top:-n[1],width:t.dpDiv.outerWidth(),height:t.dpDiv.outerHeight()})}};t.dpDiv.zIndex($(e).zIndex()+1),$.datepicker._datepickerShowing=!0,$.effects&&$.effects[o]?t.dpDiv.show(o,$.datepicker._get(t,"showOptions"),u,a):t.dpDiv[o||"show"](o?u:null,a),(!o||!u)&&a(),t.input.is(":visible")&&!t.input.is(":disabled")&&t.input.focus(),$.datepicker._curInst=t}},_updateDatepicker:function(e){var t=this;t.maxRows=4;var n=$.datepicker._getBorders(e.dpDiv);instActive=e,e.dpDiv.empty().append(this._generateHTML(e));var r=e.dpDiv.find("iframe.ui-datepicker-cover");!r.length||r.css({left:-n[0],top:-n[1],width:e.dpDiv.outerWidth(),height:e.dpDiv.outerHeight()}),e.dpDiv.find("."+this._dayOverClass+" a").mouseover();var i=this._getNumberOfMonths(e),s=i[1],o=17;e.dpDiv.removeClass("ui-datepicker-multi-2 ui-datepicker-multi-3 ui-datepicker-multi-4").width(""),s>1&&e.dpDiv.addClass("ui-datepicker-multi-"+s).css("width",o*s+"em"),e.dpDiv[(i[0]!=1||i[1]!=1?"add":"remove")+"Class"]("ui-datepicker-multi"),e.dpDiv[(this._get(e,"isRTL")?"add":"remove")+"Class"]("ui-datepicker-rtl"),e==$.datepicker._curInst&&$.datepicker._datepickerShowing&&e.input&&e.input.is(":visible")&&!e.input.is(":disabled")&&e.input[0]!=document.activeElement&&e.input.focus();if(e.yearshtml){var u=e.yearshtml;setTimeout(function(){u===e.yearshtml&&e.yearshtml&&e.dpDiv.find("select.ui-datepicker-year:first").replaceWith(e.yearshtml),u=e.yearshtml=null},0)}},_getBorders:function(e){var t=function(e){return{thin:1,medium:2,thick:3}[e]||e};return[parseFloat(t(e.css("border-left-width"))),parseFloat(t(e.css("border-top-width")))]},_checkOffset:function(e,t,n){var r=e.dpDiv.outerWidth(),i=e.dpDiv.outerHeight(),s=e.input?e.input.outerWidth():0,o=e.input?e.input.outerHeight():0,u=document.documentElement.clientWidth+$(document).scrollLeft(),a=document.documentElement.clientHeight+$(document).scrollTop();return t.left-=this._get(e,"isRTL")?r-s:0,t.left-=n&&t.left==e.input.offset().left?$(document).scrollLeft():0,t.top-=n&&t.top==e.input.offset().top+o?$(document).scrollTop():0,t.left-=Math.min(t.left,t.left+r>u&&u>r?Math.abs(t.left+r-u):0),t.top-=Math.min(t.top,t.top+i>a&&a>i?Math.abs(i+o):0),t},_findPos:function(e){var t=this._getInst(e),n=this._get(t,"isRTL");while(e&&(e.type=="hidden"||e.nodeType!=1||$.expr.filters.hidden(e)))e=e[n?"previousSibling":"nextSibling"];var r=$(e).offset();return[r.left,r.top]},_hideDatepicker:function(e){var t=this._curInst;if(!t||e&&t!=$.data(e,PROP_NAME))return;if(this._datepickerShowing){var n=this._get(t,"showAnim"),r=this._get(t,"duration"),i=function(){$.datepicker._tidyDialog(t)};$.effects&&$.effects[n]?t.dpDiv.hide(n,$.datepicker._get(t,"showOptions"),r,i):t.dpDiv[n=="slideDown"?"slideUp":n=="fadeIn"?"fadeOut":"hide"](n?r:null,i),n||i(),this._datepickerShowing=!1;var s=this._get(t,"onClose");s&&s.apply(t.input?t.input[0]:null,[t.input?t.input.val():"",t]),this._lastInput=null,this._inDialog&&(this._dialogInput.css({position:"absolute",left:"0",top:"-100px"}),$.blockUI&&($.unblockUI(),$("body").append(this.dpDiv))),this._inDialog=!1}},_tidyDialog:function(e){e.dpDiv.removeClass(this._dialogClass).unbind(".ui-datepicker-calendar")},_checkExternalClick:function(e){if(!$.datepicker._curInst)return;var t=$(e.target),n=$.datepicker._getInst(t[0]);(t[0].id!=$.datepicker._mainDivId&&t.parents("#"+$.datepicker._mainDivId).length==0&&!t.hasClass($.datepicker.markerClassName)&&!t.closest("."+$.datepicker._triggerClass).length&&$.datepicker._datepickerShowing&&(!$.datepicker._inDialog||!$.blockUI)||t.hasClass($.datepicker.markerClassName)&&$.datepicker._curInst!=n)&&$.datepicker._hideDatepicker()},_adjustDate:function(e,t,n){var r=$(e),i=this._getInst(r[0]);if(this._isDisabledDatepicker(r[0]))return;this._adjustInstDate(i,t+(n=="M"?this._get(i,"showCurrentAtPos"):0),n),this._updateDatepicker(i)},_gotoToday:function(e){var t=$(e),n=this._getInst(t[0]);if(this._get(n,"gotoCurrent")&&n.currentDay)n.selectedDay=n.currentDay,n.drawMonth=n.selectedMonth=n.currentMonth,n.drawYear=n.selectedYear=n.currentYear;else{var r=new Date;n.selectedDay=r.getDate(),n.drawMonth=n.selectedMonth=r.getMonth(),n.drawYear=n.selectedYear=r.getFullYear()}this._notifyChange(n),this._adjustDate(t)},_selectMonthYear:function(e,t,n){var r=$(e),i=this._getInst(r[0]);i["selected"+(n=="M"?"Month":"Year")]=i["draw"+(n=="M"?"Month":"Year")]=parseInt(t.options[t.selectedIndex].value,10),this._notifyChange(i),this._adjustDate(r)},_selectDay:function(e,t,n,r){var i=$(e);if($(r).hasClass(this._unselectableClass)||this._isDisabledDatepicker(i[0]))return;var s=this._getInst(i[0]);s.selectedDay=s.currentDay=$("a",r).html(),s.selectedMonth=s.currentMonth=t,s.selectedYear=s.currentYear=n,this._selectDate(e,this._formatDate(s,s.currentDay,s.currentMonth,s.currentYear))},_clearDate:function(e){var t=$(e),n=this._getInst(t[0]);this._selectDate(t,"")},_selectDate:function(e,t){var n=$(e),r=this._getInst(n[0]);t=t!=null?t:this._formatDate(r),r.input&&r.input.val(t),this._updateAlternate(r);var i=this._get(r,"onSelect");i?i.apply(r.input?r.input[0]:null,[t,r]):r.input&&r.input.trigger("change"),r.inline?this._updateDatepicker(r):(this._hideDatepicker(),this._lastInput=r.input[0],typeof r.input[0]!="object"&&r.input.focus(),this._lastInput=null)},_updateAlternate:function(e){var t=this._get(e,"altField");if(t){var n=this._get(e,"altFormat")||this._get(e,"dateFormat"),r=this._getDate(e),i=this.formatDate(n,r,this._getFormatConfig(e));$(t).each(function(){$(this).val(i)})}},noWeekends:function(e){var t=e.getDay();return[t>0&&t<6,""]},iso8601Week:function(e){var t=new Date(e.getTime());t.setDate(t.getDate()+4-(t.getDay()||7));var n=t.getTime();return t.setMonth(0),t.setDate(1),Math.floor(Math.round((n-t)/864e5)/7)+1},parseDate:function(e,t,n){if(e==null||t==null)throw"Invalid arguments";t=typeof t=="object"?t.toString():t+"";if(t=="")return null;var r=(n?n.shortYearCutoff:null)||this._defaults.shortYearCutoff;r=typeof r!="string"?r:(new Date).getFullYear()%100+parseInt(r,10);var i=(n?n.dayNamesShort:null)||this._defaults.dayNamesShort,s=(n?n.dayNames:null)||this._defaults.dayNames,o=(n?n.monthNamesShort:null)||this._defaults.monthNamesShort,u=(n?n.monthNames:null)||this._defaults.monthNames,a=-1,f=-1,l=-1,c=-1,h=!1,p=function(t){var n=y+1<e.length&&e.charAt(y+1)==t;return n&&y++,n},d=function(e){var n=p(e),r=e=="@"?14:e=="!"?20:e=="y"&&n?4:e=="o"?3:2,i=new RegExp("^\\d{1,"+r+"}"),s=t.substring(g).match(i);if(!s)throw"Missing number at position "+g;return g+=s[0].length,parseInt(s[0],10)},v=function(e,n,r){var i=$.map(p(e)?r:n,function(e,t){return[[t,e]]}).sort(function(e,t){return-(e[1].length-t[1].length)}),s=-1;$.each(i,function(e,n){var r=n[1];if(t.substr(g,r.length).toLowerCase()==r.toLowerCase())return s=n[0],g+=r.length,!1});if(s!=-1)return s+1;throw"Unknown name at position "+g},m=function(){if(t.charAt(g)!=e.charAt(y))throw"Unexpected literal at position "+g;g++},g=0;for(var y=0;y<e.length;y++)if(h)e.charAt(y)=="'"&&!p("'")?h=!1:m();else switch(e.charAt(y)){case"d":l=d("d");break;case"D":v("D",i,s);break;case"o":c=d("o");break;case"m":f=d("m");break;case"M":f=v("M",o,u);break;case"y":a=d("y");break;case"@":var b=new Date(d("@"));a=b.getFullYear(),f=b.getMonth()+1,l=b.getDate();break;case"!":var b=new Date((d("!")-this._ticksTo1970)/1e4);a=b.getFullYear(),f=b.getMonth()+1,l=b.getDate();break;case"'":p("'")?m():h=!0;break;default:m()}if(g<t.length)throw"Extra/unparsed characters found in date: "+t.substring(g);a==-1?a=(new Date).getFullYear():a<100&&(a+=(new Date).getFullYear()-(new Date).getFullYear()%100+(a<=r?0:-100));if(c>-1){f=1,l=c;do{var w=this._getDaysInMonth(a,f-1);if(l<=w)break;f++,l-=w}while(!0)}var b=this._daylightSavingAdjust(new Date(a,f-1,l));if(b.getFullYear()!=a||b.getMonth()+1!=f||b.getDate()!=l)throw"Invalid date";return b},ATOM:"yy-mm-dd",COOKIE:"D, dd M yy",ISO_8601:"yy-mm-dd",RFC_822:"D, d M y",RFC_850:"DD, dd-M-y",RFC_1036:"D, d M y",RFC_1123:"D, d M yy",RFC_2822:"D, d M yy",RSS:"D, d M y",TICKS:"!",TIMESTAMP:"@",W3C:"yy-mm-dd",_ticksTo1970:(718685+Math.floor(492.5)-Math.floor(19.7)+Math.floor(4.925))*24*60*60*1e7,formatDate:function(e,t,n){if(!t)return"";var r=(n?n.dayNamesShort:null)||this._defaults.dayNamesShort,i=(n?n.dayNames:null)||this._defaults.dayNames,s=(n?n.monthNamesShort:null)||this._defaults.monthNamesShort,o=(n?n.monthNames:null)||this._defaults.monthNames,u=function(t){var n=h+1<e.length&&e.charAt(h+1)==t;return n&&h++,n},a=function(e,t,n){var r=""+t;if(u(e))while(r.length<n)r="0"+r;return r},f=function(e,t,n,r){return u(e)?r[t]:n[t]},l="",c=!1;if(t)for(var h=0;h<e.length;h++)if(c)e.charAt(h)=="'"&&!u("'")?c=!1:l+=e.charAt(h);else switch(e.charAt(h)){case"d":l+=a("d",t.getDate(),2);break;case"D":l+=f("D",t.getDay(),r,i);break;case"o":l+=a("o",Math.round(((new Date(t.getFullYear(),t.getMonth(),t.getDate())).getTime()-(new Date(t.getFullYear(),0,0)).getTime())/864e5),3);break;case"m":l+=a("m",t.getMonth()+1,2);break;case"M":l+=f("M",t.getMonth(),s,o);break;case"y":l+=u("y")?t.getFullYear():(t.getYear()%100<10?"0":"")+t.getYear()%100;break;case"@":l+=t.getTime();break;case"!":l+=t.getTime()*1e4+this._ticksTo1970;break;case"'":u("'")?l+="'":c=!0;break;default:l+=e.charAt(h)}return l},_possibleChars:function(e){var t="",n=!1,r=function(t){var n=i+1<e.length&&e.charAt(i+1)==t;return n&&i++,n};for(var i=0;i<e.length;i++)if(n)e.charAt(i)=="'"&&!r("'")?n=!1:t+=e.charAt(i);else switch(e.charAt(i)){case"d":case"m":case"y":case"@":t+="0123456789";break;case"D":case"M":return null;case"'":r("'")?t+="'":n=!0;break;default:t+=e.charAt(i)}return t},_get:function(e,t){return e.settings[t]!==undefined?e.settings[t]:this._defaults[t]},_setDateFromField:function(e,t){if(e.input.val()==e.lastVal)return;var n=this._get(e,"dateFormat"),r=e.lastVal=e.input?e.input.val():null,i,s;i=s=this._getDefaultDate(e);var o=this._getFormatConfig(e);try{i=this.parseDate(n,r,o)||s}catch(u){this.log(u),r=t?"":r}e.selectedDay=i.getDate(),e.drawMonth=e.selectedMonth=i.getMonth(),e.drawYear=e.selectedYear=i.getFullYear(),e.currentDay=r?i.getDate():0,e.currentMonth=r?i.getMonth():0,e.currentYear=r?i.getFullYear():0,this._adjustInstDate(e)},_getDefaultDate:function(e){return this._restrictMinMax(e,this._determineDate(e,this._get(e,"defaultDate"),new Date))},_determineDate:function(e,t,n){var r=function(e){var t=new Date;return t.setDate(t.getDate()+e),t},i=function(t){try{return $.datepicker.parseDate($.datepicker._get(e,"dateFormat"),t,$.datepicker._getFormatConfig(e))}catch(n){}var r=(t.toLowerCase().match(/^c/)?$.datepicker._getDate(e):null)||new Date,i=r.getFullYear(),s=r.getMonth(),o=r.getDate(),u=/([+-]?[0-9]+)\s*(d|D|w|W|m|M|y|Y)?/g,a=u.exec(t);while(a){switch(a[2]||"d"){case"d":case"D":o+=parseInt(a[1],10);break;case"w":case"W":o+=parseInt(a[1],10)*7;break;case"m":case"M":s+=parseInt(a[1],10),o=Math.min(o,$.datepicker._getDaysInMonth(i,s));break;case"y":case"Y":i+=parseInt(a[1],10),o=Math.min(o,$.datepicker._getDaysInMonth(i,s))}a=u.exec(t)}return new Date(i,s,o)},s=t==null||t===""?n:typeof t=="string"?i(t):typeof t=="number"?isNaN(t)?n:r(t):new Date(t.getTime());return s=s&&s.toString()=="Invalid Date"?n:s,s&&(s.setHours(0),s.setMinutes(0),s.setSeconds(0),s.setMilliseconds(0)),this._daylightSavingAdjust(s)},_daylightSavingAdjust:function(e){return e?(e.setHours(e.getHours()>12?e.getHours()+2:0),e):null},_setDate:function(e,t,n){var r=!t,i=e.selectedMonth,s=e.selectedYear,o=this._restrictMinMax(e,this._determineDate(e,t,new Date));e.selectedDay=e.currentDay=o.getDate(),e.drawMonth=e.selectedMonth=e.currentMonth=o.getMonth(),e.drawYear=e.selectedYear=e.currentYear=o.getFullYear(),(i!=e.selectedMonth||s!=e.selectedYear)&&!n&&this._notifyChange(e),this._adjustInstDate(e),e.input&&e.input.val(r?"":this._formatDate(e))},_getDate:function(e){var t=!e.currentYear||e.input&&e.input.val()==""?null:this._daylightSavingAdjust(new Date(e.currentYear,e.currentMonth,e.currentDay));return t},_generateHTML:function(e){var t=new Date;t=this._daylightSavingAdjust(new Date(t.getFullYear(),t.getMonth(),t.getDate()));var n=this._get(e,"isRTL"),r=this._get(e,"showButtonPanel"),i=this._get(e,"hideIfNoPrevNext"),s=this._get(e,"navigationAsDateFormat"),o=this._getNumberOfMonths(e),u=this._get(e,"showCurrentAtPos"),a=this._get(e,"stepMonths"),f=o[0]!=1||o[1]!=1,l=this._daylightSavingAdjust(e.currentDay?new Date(e.currentYear,e.currentMonth,e.currentDay):new Date(9999,9,9)),c=this._getMinMaxDate(e,"min"),h=this._getMinMaxDate(e,"max"),p=e.drawMonth-u,d=e.drawYear;p<0&&(p+=12,d--);if(h){var v=this._daylightSavingAdjust(new Date(h.getFullYear(),h.getMonth()-o[0]*o[1]+1,h.getDate()));v=c&&v<c?c:v;while(this._daylightSavingAdjust(new Date(d,p,1))>v)p--,p<0&&(p=11,d--)}e.drawMonth=p,e.drawYear=d;var m=this._get(e,"prevText");m=s?this.formatDate(m,this._daylightSavingAdjust(new Date(d,p-a,1)),this._getFormatConfig(e)):m;var g=this._canAdjustMonth(e,-1,d,p)?'<a class="ui-datepicker-prev ui-corner-all" onclick="DP_jQuery_'+dpuuid+".datepicker._adjustDate('#"+e.id+"', -"+a+", 'M');\""+' title="'+m+'"><span class="ui-icon ui-icon-circle-triangle-'+(n?"e":"w")+'">'+m+"</span></a>":i?"":'<a class="ui-datepicker-prev ui-corner-all ui-state-disabled" title="'+m+'"><span class="ui-icon ui-icon-circle-triangle-'+(n?"e":"w")+'">'+m+"</span></a>",y=this._get(e,"nextText");y=s?this.formatDate(y,this._daylightSavingAdjust(new Date(d,p+a,1)),this._getFormatConfig(e)):y;var b=this._canAdjustMonth(e,1,d,p)?'<a class="ui-datepicker-next ui-corner-all" onclick="DP_jQuery_'+dpuuid+".datepicker._adjustDate('#"+e.id+"', +"+a+", 'M');\""+' title="'+y+'"><span class="ui-icon ui-icon-circle-triangle-'+(n?"w":"e")+'">'+y+"</span></a>":i?"":'<a class="ui-datepicker-next ui-corner-all ui-state-disabled" title="'+y+'"><span class="ui-icon ui-icon-circle-triangle-'+(n?"w":"e")+'">'+y+"</span></a>",w=this._get(e,"currentText"),E=this._get(e,"gotoCurrent")&&e.currentDay?l:t;w=s?this.formatDate(w,E,this._getFormatConfig(e)):w;var S=e.inline?"":'<button type="button" class="ui-datepicker-close ui-state-default ui-priority-primary ui-corner-all" onclick="DP_jQuery_'+dpuuid+'.datepicker._hideDatepicker();">'+this._get(e,"closeText")+"</button>",x=r?'<div class="ui-datepicker-buttonpane ui-widget-content">'+(n?S:"")+(this._isInRange(e,E)?'<button type="button" class="ui-datepicker-current ui-state-default ui-priority-secondary ui-corner-all" onclick="DP_jQuery_'+dpuuid+".datepicker._gotoToday('#"+e.id+"');\""+">"+w+"</button>":"")+(n?"":S)+"</div>":"",T=parseInt(this._get(e,"firstDay"),10);T=isNaN(T)?0:T;var N=this._get(e,"showWeek"),C=this._get(e,"dayNames"),k=this._get(e,"dayNamesShort"),L=this._get(e,"dayNamesMin"),A=this._get(e,"monthNames"),O=this._get(e,"monthNamesShort"),M=this._get(e,"beforeShowDay"),_=this._get(e,"showOtherMonths"),D=this._get(e,"selectOtherMonths"),P=this._get(e,"calculateWeek")||this.iso8601Week,H=this._getDefaultDate(e),B="";for(var j=0;j<o[0];j++){var F="";this.maxRows=4;for(var I=0;I<o[1];I++){var q=this._daylightSavingAdjust(new Date(d,p,e.selectedDay)),R=" ui-corner-all",U="";if(f){U+='<div class="ui-datepicker-group';if(o[1]>1)switch(I){case 0:U+=" ui-datepicker-group-first",R=" ui-corner-"+(n?"right":"left");break;case o[1]-1:U+=" ui-datepicker-group-last",R=" ui-corner-"+(n?"left":"right");break;default:U+=" ui-datepicker-group-middle",R=""}U+='">'}U+='<div class="ui-datepicker-header ui-widget-header ui-helper-clearfix'+R+'">'+(/all|left/.test(R)&&j==0?n?b:g:"")+(/all|right/.test(R)&&j==0?n?g:b:"")+this._generateMonthYearHeader(e,p,d,c,h,j>0||I>0,A,O)+'</div><table class="ui-datepicker-calendar"><thead>'+"<tr>";var z=N?'<th class="ui-datepicker-week-col">'+this._get(e,"weekHeader")+"</th>":"";for(var W=0;W<7;W++){var X=(W+T)%7;z+="<th"+((W+T+6)%7>=5?' class="ui-datepicker-week-end"':"")+">"+'<span title="'+C[X]+'">'+L[X]+"</span></th>"}U+=z+"</tr></thead><tbody>";var V=this._getDaysInMonth(d,p);d==e.selectedYear&&p==e.selectedMonth&&(e.selectedDay=Math.min(e.selectedDay,V));var J=(this._getFirstDayOfMonth(d,p)-T+7)%7,K=Math.ceil((J+V)/7),Q=f?this.maxRows>K?this.maxRows:K:K;this.maxRows=Q;var G=this._daylightSavingAdjust(new Date(d,p,1-J));for(var Y=0;Y<Q;Y++){U+="<tr>";var Z=N?'<td class="ui-datepicker-week-col">'+this._get(e,"calculateWeek")(G)+"</td>":"";for(var W=0;W<7;W++){var et=M?M.apply(e.input?e.input[0]:null,[G]):[!0,""],tt=G.getMonth()!=p,nt=tt&&!D||!et[0]||c&&G<c||h&&G>h;Z+='<td class="'+((W+T+6)%7>=5?" ui-datepicker-week-end":"")+(tt?" ui-datepicker-other-month":"")+(G.getTime()==q.getTime()&&p==e.selectedMonth&&e._keyEvent||H.getTime()==G.getTime()&&H.getTime()==q.getTime()?" "+this._dayOverClass:"")+(nt?" "+this._unselectableClass+" ui-state-disabled":"")+(tt&&!_?"":" "+et[1]+(G.getTime()==l.getTime()?" "+this._currentClass:"")+(G.getTime()==t.getTime()?" ui-datepicker-today":""))+'"'+((!tt||_)&&et[2]?' title="'+et[2]+'"':"")+(nt?"":' onclick="DP_jQuery_'+dpuuid+".datepicker._selectDay('#"+e.id+"',"+G.getMonth()+","+G.getFullYear()+', this);return false;"')+">"+(tt&&!_?"&#xa0;":nt?'<span class="ui-state-default">'+G.getDate()+"</span>":'<a class="ui-state-default'+(G.getTime()==t.getTime()?" ui-state-highlight":"")+(G.getTime()==l.getTime()?" ui-state-active":"")+(tt?" ui-priority-secondary":"")+'" href="#">'+G.getDate()+"</a>")+"</td>",G.setDate(G.getDate()+1),G=this._daylightSavingAdjust(G)}U+=Z+"</tr>"}p++,p>11&&(p=0,d++),U+="</tbody></table>"+(f?"</div>"+(o[0]>0&&I==o[1]-1?'<div class="ui-datepicker-row-break"></div>':""):""),F+=U}B+=F}return B+=x+($.browser.msie&&parseInt($.browser.version,10)<7&&!e.inline?'<iframe src="javascript:false;" class="ui-datepicker-cover" frameborder="0"></iframe>':""),e._keyEvent=!1,B},_generateMonthYearHeader:function(e,t,n,r,i,s,o,u){var a=this._get(e,"changeMonth"),f=this._get(e,"changeYear"),l=this._get(e,"showMonthAfterYear"),c='<div class="ui-datepicker-title">',h="";if(s||!a)h+='<span class="ui-datepicker-month">'+o[t]+"</span>";else{var p=r&&r.getFullYear()==n,d=i&&i.getFullYear()==n;h+='<select class="ui-datepicker-month" onchange="DP_jQuery_'+dpuuid+".datepicker._selectMonthYear('#"+e.id+"', this, 'M');\" "+">";for(var v=0;v<12;v++)(!p||v>=r.getMonth())&&(!d||v<=i.getMonth())&&(h+='<option value="'+v+'"'+(v==t?' selected="selected"':"")+">"+u[v]+"</option>");h+="</select>"}l||(c+=h+(s||!a||!f?"&#xa0;":""));if(!e.yearshtml){e.yearshtml="";if(s||!f)c+='<span class="ui-datepicker-year">'+n+"</span>";else{var m=this._get(e,"yearRange").split(":"),g=(new Date).getFullYear(),y=function(e){var t=e.match(/c[+-].*/)?n+parseInt(e.substring(1),10):e.match(/[+-].*/)?g+parseInt(e,10):parseInt(e,10);return isNaN(t)?g:t},b=y(m[0]),w=Math.max(b,y(m[1]||""));b=r?Math.max(b,r.getFullYear()):b,w=i?Math.min(w,i.getFullYear()):w,e.yearshtml+='<select class="ui-datepicker-year" onchange="DP_jQuery_'+dpuuid+".datepicker._selectMonthYear('#"+e.id+"', this, 'Y');\" "+">";for(;b<=w;b++)e.yearshtml+='<option value="'+b+'"'+(b==n?' selected="selected"':"")+">"+b+"</option>";e.yearshtml+="</select>",c+=e.yearshtml,e.yearshtml=null}}return c+=this._get(e,"yearSuffix"),l&&(c+=(s||!a||!f?"&#xa0;":"")+h),c+="</div>",c},_adjustInstDate:function(e,t,n){var r=e.drawYear+(n=="Y"?t:0),i=e.drawMonth+(n=="M"?t:0),s=Math.min(e.selectedDay,this._getDaysInMonth(r,i))+(n=="D"?t:0),o=this._restrictMinMax(e,this._daylightSavingAdjust(new Date(r,i,s)));e.selectedDay=o.getDate(),e.drawMonth=e.selectedMonth=o.getMonth(),e.drawYear=e.selectedYear=o.getFullYear(),(n=="M"||n=="Y")&&this._notifyChange(e)},_restrictMinMax:function(e,t){var n=this._getMinMaxDate(e,"min"),r=this._getMinMaxDate(e,"max"),i=n&&t<n?n:t;return i=r&&i>r?r:i,i},_notifyChange:function(e){var t=this._get(e,"onChangeMonthYear");t&&t.apply(e.input?e.input[0]:null,[e.selectedYear,e.selectedMonth+1,e])},_getNumberOfMonths:function(e){var t=this._get(e,"numberOfMonths");return t==null?[1,1]:typeof t=="number"?[1,t]:t},_getMinMaxDate:function(e,t){return this._determineDate(e,this._get(e,t+"Date"),null)},_getDaysInMonth:function(e,t){return 32-this._daylightSavingAdjust(new Date(e,t,32)).getDate()},_getFirstDayOfMonth:function(e,t){return(new Date(e,t,1)).getDay()},_canAdjustMonth:function(e,t,n,r){var i=this._getNumberOfMonths(e),s=this._daylightSavingAdjust(new Date(n,r+(t<0?t:i[0]*i[1]),1));return t<0&&s.setDate(this._getDaysInMonth(s.getFullYear(),s.getMonth())),this._isInRange(e,s)},_isInRange:function(e,t){var n=this._getMinMaxDate(e,"min"),r=this._getMinMaxDate(e,"max");return(!n||t.getTime()>=n.getTime())&&(!r||t.getTime()<=r.getTime())},_getFormatConfig:function(e){var t=this._get(e,"shortYearCutoff");return t=typeof t!="string"?t:(new Date).getFullYear()%100+parseInt(t,10),{shortYearCutoff:t,dayNamesShort:this._get(e,"dayNamesShort"),dayNames:this._get(e,"dayNames"),monthNamesShort:this._get(e,"monthNamesShort"),monthNames:this._get(e,"monthNames")}},_formatDate:function(e,t,n,r){t||(e.currentDay=e.selectedDay,e.currentMonth=e.selectedMonth,e.currentYear=e.selectedYear);var i=t?typeof t=="object"?t:this._daylightSavingAdjust(new Date(r,n,t)):this._daylightSavingAdjust(new Date(e.currentYear,e.currentMonth,e.currentDay));return this.formatDate(this._get(e,"dateFormat"),i,this._getFormatConfig(e))}}),$.fn.datepicker=function(e){if(!this.length)return this;$.datepicker.initialized||($(document).mousedown($.datepicker._checkExternalClick).find("body").append($.datepicker.dpDiv),$.datepicker.initialized=!0);var t=Array.prototype.slice.call(arguments,1);return typeof e!="string"||e!="isDisabled"&&e!="getDate"&&e!="widget"?e=="option"&&arguments.length==2&&typeof arguments[1]=="string"?$.datepicker["_"+e+"Datepicker"].apply($.datepicker,[this[0]].concat(t)):this.each(function(){typeof e=="string"?$.datepicker["_"+e+"Datepicker"].apply($.datepicker,[this].concat(t)):$.datepicker._attachDatepicker(this,e)}):$.datepicker["_"+e+"Datepicker"].apply($.datepicker,[this[0]].concat(t))},$.datepicker=new Datepicker,$.datepicker.initialized=!1,$.datepicker.uuid=(new Date).getTime(),$.datepicker.version="@VERSION",window["DP_jQuery_"+dpuuid]=$}(jQuery),function(e,t){var n="ui-dialog ui-widget ui-widget-content ui-corner-all ",r={buttons:!0,height:!0,maxHeight:!0,maxWidth:!0,minHeight:!0,minWidth:!0,width:!0},i={maxHeight:!0,maxWidth:!0,minHeight:!0,minWidth:!0},s=e.attrFn||{val:!0,css:!0,html:!0,text:!0,data:!0,width:!0,height:!0,offset:!0,click:!0};e.widget("ui.dialog",{options:{autoOpen:!0,buttons:{},closeOnEscape:!0,closeText:"close",dialogClass:"",draggable:!0,hide:null,height:"auto",maxHeight:!1,maxWidth:!1,minHeight:150,minWidth:150,modal:!1,position:{my:"center",at:"center",collision:"fit",using:function(t){var n=e(this).css(t).offset().top;n<0&&e(this).css("top",t.top-n)}},resizable:!0,show:null,stack:!0,title:"",width:300,zIndex:1e3},_create:function(){this.originalTitle=this.element.attr("title"),typeof this.originalTitle!="string"&&(this.originalTitle=""),this.options.title=this.options.title||this.originalTitle;var t=this,r=t.options,i=r.title||"&#160;",s=e.ui.dialog.getTitleId(t.element),o=(t.uiDialog=e("<div></div>")).appendTo(document.body).hide().addClass(n+r.dialogClass).css({zIndex:r.zIndex}).attr("tabIndex",-1).css("outline",0).keydown(function(n){r.closeOnEscape&&!n.isDefaultPrevented()&&n.keyCode&&n.keyCode===e.ui.keyCode.ESCAPE&&(t.close(n),n.preventDefault())}).attr({role:"dialog","aria-labelledby":s}).mousedown(function(e){t.moveToTop(!1,e)}),u=t.element.show().removeAttr("title").addClass("ui-dialog-content ui-widget-content").appendTo(o),a=(t.uiDialogTitlebar=e("<div></div>")).addClass("ui-dialog-titlebar ui-widget-header ui-corner-all ui-helper-clearfix").prependTo(o),f=e('<a href="#"></a>').addClass("ui-dialog-titlebar-close ui-corner-all").attr("role","button").hover(function(){f.addClass("ui-state-hover")},function(){f.removeClass("ui-state-hover")}).focus(function(){f.addClass("ui-state-focus")}).blur(function(){f.removeClass("ui-state-focus")}).click(function(e){return t.close(e),!1}).appendTo(a),l=(t.uiDialogTitlebarCloseText=e("<span></span>")).addClass("ui-icon ui-icon-closethick").text(r.closeText).appendTo(f),c=e("<span></span>").addClass("ui-dialog-title").attr("id",s).html(i).prependTo(a);e.isFunction(r.beforeclose)&&!e.isFunction(r.beforeClose)&&(r.beforeClose=r.beforeclose),a.find("*").add(a).disableSelection(),r.draggable&&e.fn.draggable&&t._makeDraggable(),r.resizable&&e.fn.resizable&&t._makeResizable(),t._createButtons(r.buttons),t._isOpen=!1,e.fn.bgiframe&&o.bgiframe()},_init:function(){this.options.autoOpen&&this.open()},destroy:function(){var e=this;return e.overlay&&e.overlay.destroy(),e.uiDialog.hide(),e.element.unbind(".dialog").removeData("dialog").removeClass("ui-dialog-content ui-widget-content").hide().appendTo("body"),e.uiDialog.remove(),e.originalTitle&&e.element.attr("title",e.originalTitle),e},widget:function(){return this.uiDialog},close:function(t){var n=this,r,i;if(!1===n._trigger("beforeClose",t))return;return n.overlay&&n.overlay.destroy(),n.uiDialog.unbind("keypress.ui-dialog"),n._isOpen=!1,n.options.hide?n.uiDialog.hide(n.options.hide,function(){n._trigger("close",t)}):(n.uiDialog.hide(),n._trigger("close",t)),e.ui.dialog.overlay.resize(),n.options.modal&&(r=0,e(".ui-dialog").each(function(){this!==n.uiDialog[0]&&(i=e(this).css("z-index"),isNaN(i)||(r=Math.max(r,i)))}),e.ui.dialog.maxZ=r),n},isOpen:function(){return this._isOpen},moveToTop:function(t,n){var r=this,i=r.options,s;return i.modal&&!t||!i.stack&&!i.modal?r._trigger("focus",n):(i.zIndex>e.ui.dialog.maxZ&&(e.ui.dialog.maxZ=i.zIndex),r.overlay&&(e.ui.dialog.maxZ+=1,r.overlay.$el.css("z-index",e.ui.dialog.overlay.maxZ=e.ui.dialog.maxZ)),s={scrollTop:r.element.scrollTop(),scrollLeft:r.element.scrollLeft()},e.ui.dialog.maxZ+=1,r.uiDialog.css("z-index",e.ui.dialog.maxZ),r.element.attr(s),r._trigger("focus",n),r)},open:function(){if(this._isOpen)return;var t=this,n=t.options,r=t.uiDialog;return t.overlay=n.modal?new e.ui.dialog.overlay(t):null,t._size(),t._position(n.position),r.show(n.show),t.moveToTop(!0),n.modal&&r.bind("keydown.ui-dialog",function(t){if(t.keyCode!==e.ui.keyCode.TAB)return;var n=e(":tabbable",this),r=n.filter(":first"),i=n.filter(":last");if(t.target===i[0]&&!t.shiftKey)return r.focus(1),!1;if(t.target===r[0]&&t.shiftKey)return i.focus(1),!1}),e(t.element.find(":tabbable").get().concat(r.find(".ui-dialog-buttonpane :tabbable").get().concat(r.get()))).eq(0).focus(),t._isOpen=!0,t._trigger("open"),t},_createButtons:function(t){var n=this,r=!1,i=e("<div></div>").addClass("ui-dialog-buttonpane ui-widget-content ui-helper-clearfix"),o=e("<div></div>").addClass("ui-dialog-buttonset").appendTo(i);n.uiDialog.find(".ui-dialog-buttonpane").remove(),typeof t=="object"&&t!==null&&e.each(t,function(){return!(r=!0)}),r&&(e.each(t,function(t,r){r=e.isFunction(r)?{click:r,text:t}:r;var i=e('<button type="button"></button>').click(function(){r.click.apply(n.element[0],arguments)}).appendTo(o);e.each(r,function(e,t){if(e==="click")return;e in s?i[e](t):i.attr(e,t)}),e.fn.button&&i.button()}),i.appendTo(n.uiDialog))},_makeDraggable:function(){function s(e){return{position:e.position,offset:e.offset}}var t=this,n=t.options,r=e(document),i;t.uiDialog.draggable({cancel:".ui-dialog-content, .ui-dialog-titlebar-close",handle:".ui-dialog-titlebar",containment:"document",start:function(r,o){i=n.height==="auto"?"auto":e(this).height(),e(this).height(e(this).height()).addClass("ui-dialog-dragging"),t._trigger("dragStart",r,s(o))},drag:function(e,n){t._trigger("drag",e,s(n))},stop:function(o,u){n.position=[u.position.left-r.scrollLeft(),u.position.top-r.scrollTop()],e(this).removeClass("ui-dialog-dragging").height(i),t._trigger("dragStop",o,s(u)),e.ui.dialog.overlay.resize()}})},_makeResizable:function(n){function u(e){return{originalPosition:e.originalPosition,originalSize:e.originalSize,position:e.position,size:e.size}}n=n===t?this.options.resizable:n;var r=this,i=r.options,s=r.uiDialog.css("position"),o=typeof n=="string"?n:"n,e,s,w,se,sw,ne,nw";r.uiDialog.resizable({cancel:".ui-dialog-content",containment:"document",alsoResize:r.element,maxWidth:i.maxWidth,maxHeight:i.maxHeight,minWidth:i.minWidth,minHeight:r._minHeight(),handles:o,start:function(t,n){e(this).addClass("ui-dialog-resizing"),r._trigger("resizeStart",t,u(n))},resize:function(e,t){r._trigger("resize",e,u(t))},stop:function(t,n){e(this).removeClass("ui-dialog-resizing"),i.height=e(this).height(),i.width=e(this).width(),r._trigger("resizeStop",t,u(n)),e.ui.dialog.overlay.resize()}}).css("position",s).find(".ui-resizable-se").addClass("ui-icon ui-icon-grip-diagonal-se")},_minHeight:function(){var e=this.options;return e.height==="auto"?e.minHeight:Math.min(e.minHeight,e.height)},_position:function(t){var n=[],r=[0,0],i;if(t){if(typeof t=="string"||typeof t=="object"&&"0"in t)n=t.split?t.split(" "):[t[0],t[1]],n.length===1&&(n[1]=n[0]),e.each(["left","top"],function(e,t){+n[e]===n[e]&&(r[e]=n[e],n[e]=t)}),t={my:n.join(" "),at:n.join(" "),offset:r.join(" ")};t=e.extend({},e.ui.dialog.prototype.options.position,t)}else t=e.ui.dialog.prototype.options.position;i=this.uiDialog.is(":visible"),i||this.uiDialog.show(),this.uiDialog.css({top:0,left:0}).position(e.extend({of:window},t)),i||this.uiDialog.hide()},_setOptions:function(t){var n=this,s={},o=!1;e.each(t,function(e,t){n._setOption(e,t),e in r&&(o=!0),e in i&&(s[e]=t)}),o&&this._size(),this.uiDialog.is(":data(resizable)")&&this.uiDialog.resizable("option",s)},_setOption:function(t,r){var i=this,s=i.uiDialog;switch(t){case"beforeclose":t="beforeClose";break;case"buttons":i._createButtons(r);break;case"closeText":i.uiDialogTitlebarCloseText.text(""+r);break;case"dialogClass":s.removeClass(i.options.dialogClass).addClass(n+r);break;case"disabled":r?s.addClass("ui-dialog-disabled"):s.removeClass("ui-dialog-disabled");break;case"draggable":var o=s.is(":data(draggable)");o&&!r&&s.draggable("destroy"),!o&&r&&i._makeDraggable();break;case"position":i._position(r);break;case"resizable":var u=s.is(":data(resizable)");u&&!r&&s.resizable("destroy"),u&&typeof r=="string"&&s.resizable("option","handles",r),!u&&r!==!1&&i._makeResizable(r);break;case"title":e(".ui-dialog-title",i.uiDialogTitlebar).html(""+(r||"&#160;"))}e.Widget.prototype._setOption.apply(i,arguments)},_size:function(){var t=this.options,n,r,i=this.uiDialog.is(":visible");this.element.show().css({width:"auto",minHeight:0,height:0}),t.minWidth>t.width&&(t.width=t.minWidth),n=this.uiDialog.css({height:"auto",width:t.width}).height(),r=Math.max(0,t.minHeight-n);if(t.height==="auto")if(e.support.minHeight)this.element.css({minHeight:r,height:"auto"});else{this.uiDialog.show();var s=this.element.css("height","auto").height();i||this.uiDialog.hide(),this.element.height(Math.max(s,r))}else this.element.height(Math.max(t.height-n,0));this.uiDialog.is(":data(resizable)")&&this.uiDialog.resizable("option","minHeight",this._minHeight())}}),e.extend(e.ui.dialog,{version:"@VERSION",uuid:0,maxZ:0,getTitleId:function(e){var t=e.attr("id");return t||(this.uuid+=1,t=this.uuid),"ui-dialog-title-"+t},overlay:function(t){this.$el=e.ui.dialog.overlay.create(t)}}),e.extend(e.ui.dialog.overlay,{instances:[],oldInstances:[],maxZ:0,events:e.map("focus,mousedown,mouseup,keydown,keypress,click".split(","),function(e){return e+".dialog-overlay"}).join(" "),create:function(t){this.instances.length===0&&(setTimeout(function(){e.ui.dialog.overlay.instances.length&&e(document).bind(e.ui.dialog.overlay.events,function(t){if(e(t.target).zIndex()<e.ui.dialog.overlay.maxZ)return!1})},1),e(document).bind("keydown.dialog-overlay",function(n){t.options.closeOnEscape&&!n.isDefaultPrevented()&&n.keyCode&&n.keyCode===e.ui.keyCode.ESCAPE&&(t.close(n),n.preventDefault())}),e(window).bind("resize.dialog-overlay",e.ui.dialog.overlay.resize));var n=(this.oldInstances.pop()||e("<div></div>").addClass("ui-widget-overlay")).appendTo(document.body).css({width:this.width(),height:this.height()});return e.fn.bgiframe&&n.bgiframe(),this.instances.push(n),n},destroy:function(t){var n=e.inArray(t,this.instances);n!=-1&&this.oldInstances.push(this.instances.splice(n,1)[0]),this.instances.length===0&&e([document,window]).unbind(".dialog-overlay"),t.remove();var r=0;e.each(this.instances,function(){r=Math.max(r,this.css("z-index"))}),this.maxZ=r},height:function(){var t,n;return e.browser.msie&&e.browser.version<7?(t=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight),n=Math.max(document.documentElement.offsetHeight,document.body.offsetHeight),t<n?e(window).height()+"px":t+"px"):e(document).height()+"px"},width:function(){var t,n;return e.browser.msie?(t=Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),n=Math.max(document.documentElement.offsetWidth,document.body.offsetWidth),t<n?e(window).width()+"px":t+"px"):e(document).width()+"px"},resize:function(){var t=e([]);e.each(e.ui.dialog.overlay.instances,function(){t=t.add(this)}),t.css({width:0,height:0}).css({width:e.ui.dialog.overlay.width(),height:e.ui.dialog.overlay.height()})}}),e.extend(e.ui.dialog.overlay.prototype,{destroy:function(){e.ui.dialog.overlay.destroy(this.$el)}})}(jQuery),function(e,t){e.ui=e.ui||{};var n=/left|center|right/,r=/top|center|bottom/,i="center",s={},o=e.fn.position,u=e.fn.offset;e.fn.position=function(t){if(!t||!t.of)return o.apply(this,arguments);t=e.extend({},t);var u=e(t.of),a=u[0],f=(t.collision||"flip").split(" "),l=t.offset?t.offset.split(" "):[0,0],c,h,p;return a.nodeType===9?(c=u.width(),h=u.height(),p={top:0,left:0}):a.setTimeout?(c=u.width(),h=u.height(),p={top:u.scrollTop(),left:u.scrollLeft()}):a.preventDefault?(t.at="left top",c=h=0,p={top:t.of.pageY,left:t.of.pageX}):(c=u.outerWidth(),h=u.outerHeight(),p=u.offset()),e.each(["my","at"],function(){var e=(t[this]||"").split(" ");e.length===1&&(e=n.test(e[0])?e.concat([i]):r.test(e[0])?[i].concat(e):[i,i]),e[0]=n.test(e[0])?e[0]:i,e[1]=r.test(e[1])?e[1]:i,t[this]=e}),f.length===1&&(f[1]=f[0]),l[0]=parseInt(l[0],10)||0,l.length===1&&(l[1]=l[0]),l[1]=parseInt(l[1],10)||0,t.at[0]==="right"?p.left+=c:t.at[0]===i&&(p.left+=c/2),t.at[1]==="bottom"?p.top+=h:t.at[1]===i&&(p.top+=h/2),p.left+=l[0],p.top+=l[1],this.each(function(){var n=e(this),r=n.outerWidth(),o=n.outerHeight(),u=parseInt(e.curCSS(this,"marginLeft",!0))||0,a=parseInt(e.curCSS(this,"marginTop",!0))||0,d=r+u+(parseInt(e.curCSS(this,"marginRight",!0))||0),v=o+a+(parseInt(e.curCSS(this,"marginBottom",!0))||0),m=e.extend({},p),g;t.my[0]==="right"?m.left-=r:t.my[0]===i&&(m.left-=r/2),t.my[1]==="bottom"?m.top-=o:t.my[1]===i&&(m.top-=o/2),s.fractions||(m.left=Math.round(m.left),m.top=Math.round(m.top)),g={left:m.left-u,top:m.top-a},e.each(["left","top"],function(n,i){e.ui.position[f[n]]&&e.ui.position[f[n]][i](m,{targetWidth:c,targetHeight:h,elemWidth:r,elemHeight:o,collisionPosition:g,collisionWidth:d,collisionHeight:v,offset:l,my:t.my,at:t.at})}),e.fn.bgiframe&&n.bgiframe(),n.offset(e.extend(m,{using:t.using}))})},e.ui.position={fit:{left:function(t,n){var r=e(window),i=n.collisionPosition.left+n.collisionWidth-r.width()-r.scrollLeft();t.left=i>0?t.left-i:Math.max(t.left-n.collisionPosition.left,t.left)},top:function(t,n){var r=e(window),i=n.collisionPosition.top+n.collisionHeight-r.height()-r.scrollTop();t.top=i>0?t.top-i:Math.max(t.top-n.collisionPosition.top,t.top)}},flip:{left:function(t,n){if(n.at[0]===i)return;var r=e(window),s=n.collisionPosition.left+n.collisionWidth-r.width()-r.scrollLeft(),o=n.my[0]==="left"?-n.elemWidth:n.my[0]==="right"?n.elemWidth:0,u=n.at[0]==="left"?n.targetWidth:-n.targetWidth,a=-2*n.offset[0];t.left+=n.collisionPosition.left<0?o+u+a:s>0?o+u+a:0},top:function(t,n){if(n.at[1]===i)return;var r=e(window),s=n.collisionPosition.top+n.collisionHeight-r.height()-r.scrollTop(),o=n.my[1]==="top"?-n.elemHeight:n.my[1]==="bottom"?n.elemHeight:0,u=n.at[1]==="top"?n.targetHeight:-n.targetHeight,a=-2*n.offset[1];t.top+=n.collisionPosition.top<0?o+u+a:s>0?o+u+a:0}}},e.offset.setOffset||(e.offset.setOffset=function(t,n){/static/.test(e.curCSS(t,"position"))&&(t.style.position="relative");var r=e(t),i=r.offset(),s=parseInt(e.curCSS(t,"top",!0),10)||0,o=parseInt(e.curCSS(t,"left",!0),10)||0,u={top:n.top-i.top+s,left:n.left-i.left+o};"using"in n?n.using.call(t,u):r.css(u)},e.fn.offset=function(t){var n=this[0];return!n||!n.ownerDocument?null:t?this.each(function(){e.offset.setOffset(this,t)}):u.call(this)}),function(){var t=document.getElementsByTagName("body")[0],n=document.createElement("div"),r,i,o,u,a;r=document.createElement(t?"div":"body"),o={visibility:"hidden",width:0,height:0,border:0,margin:0,background:"none"},t&&e.extend(o,{position:"absolute",left:"-1000px",top:"-1000px"});for(var f in o)r.style[f]=o[f];r.appendChild(n),i=t||document.documentElement,i.insertBefore(r,i.firstChild),n.style.cssText="position: absolute; left: 10.7432222px; top: 10.432325px; height: 30px; width: 201px;",u=e(n).offset(function(e,t){return t}).offset(),r.innerHTML="",i.removeChild(r),a=u.top+u.left+(t?2e3:0),s.fractions=a>21&&a<22}()}(jQuery),function(e,t){e.widget("ui.progressbar",{options:{value:0,max:100},min:0,_create:function(){this.element.addClass("ui-progressbar ui-widget ui-widget-content ui-corner-all").attr({role:"progressbar","aria-valuemin":this.min,"aria-valuemax":this.options.max,"aria-valuenow":this._value()}),this.valueDiv=e("<div class='ui-progressbar-value ui-widget-header ui-corner-left'></div>").appendTo(this.element),this.oldValue=this._value(),this._refreshValue()},destroy:function(){this.element.removeClass("ui-progressbar ui-widget ui-widget-content ui-corner-all").removeAttr("role").removeAttr("aria-valuemin").removeAttr("aria-valuemax").removeAttr("aria-valuenow"),this.valueDiv.remove(),e.Widget.prototype.destroy.apply(this,arguments)},value:function(e){return e===t?this._value():(this._setOption("value",e),this)},_setOption:function(t,n){t==="value"&&(this.options.value=n,this._refreshValue(),this._value()===this.options.max&&this._trigger("complete")),e.Widget.prototype._setOption.apply(this,arguments)},_value:function(){var e=this.options.value;return typeof e!="number"&&(e=0),Math.min(this.options.max,Math.max(this.min,e))},_percentage:function(){return 100*this._value()/this.options.max},_refreshValue:function(){var e=this.value(),t=this._percentage();this.oldValue!==e&&(this.oldValue=e,this._trigger("change")),this.valueDiv.toggle(e>this.min).toggleClass("ui-corner-right",e===this.options.max).width(t.toFixed(0)+"%"),this.element.attr("aria-valuenow",e)}}),e.extend(e.ui.progressbar,{version:"@VERSION"})}(jQuery),function(e,t){var n=5;e.widget("ui.slider",e.ui.mouse,{widgetEventPrefix:"slide",options:{animate:!1,distance:0,max:100,min:0,orientation:"horizontal",range:!1,step:1,value:0,values:null},_create:function(){var t=this,r=this.options,i=this.element.find(".ui-slider-handle").addClass("ui-state-default ui-corner-all"),s="<a class='ui-slider-handle ui-state-default ui-corner-all' href='#'></a>",o=r.values&&r.values.length||1,u=[];this._keySliding=!1,this._mouseSliding=!1,this._animateOff=!0,this._handleIndex=null,this._detectOrientation(),this._mouseInit(),this.element.addClass("ui-slider ui-slider-"+this.orientation+" ui-widget"+" ui-widget-content"+" ui-corner-all"+(r.disabled?" ui-slider-disabled ui-disabled":"")),this.range=e([]),r.range&&(r.range===!0&&(r.values||(r.values=[this._valueMin(),this._valueMin()]),r.values.length&&r.values.length!==2&&(r.values=[r.values[0],r.values[0]])),this.range=e("<div></div>").appendTo(this.element).addClass("ui-slider-range ui-widget-header"+(r.range==="min"||r.range==="max"?" ui-slider-range-"+r.range:"")));for(var a=i.length;a<o;a+=1)u.push(s);this.handles=i.add(e(u.join("")).appendTo(t.element)),this.handle=this.handles.eq(0),this.handles.add(this.range).filter("a").click(function(e){e.preventDefault()}).hover(function(){r.disabled||e(this).addClass("ui-state-hover")},function(){e(this).removeClass("ui-state-hover")}).focus(function(){r.disabled?e(this).blur():(e(".ui-slider .ui-state-focus").removeClass("ui-state-focus"),e(this).addClass("ui-state-focus"))}).blur(function(){e(this).removeClass("ui-state-focus")}),this.handles.each(function(t){e(this).data("index.ui-slider-handle",t)}),this.handles.keydown(function(r){var i=e(this).data("index.ui-slider-handle"),s,o,u,a;if(t.options.disabled)return;switch(r.keyCode){case e.ui.keyCode.HOME:case e.ui.keyCode.END:case e.ui.keyCode.PAGE_UP:case e.ui.keyCode.PAGE_DOWN:case e.ui.keyCode.UP:case e.ui.keyCode.RIGHT:case e.ui.keyCode.DOWN:case e.ui.keyCode.LEFT:r.preventDefault();if(!t._keySliding){t._keySliding=!0,e(this).addClass("ui-state-active"),s=t._start(r,i);if(s===!1)return}}a=t.options.step,t.options.values&&t.options.values.length?o=u=t.values(i):o=u=t.value();switch(r.keyCode){case e.ui.keyCode.HOME:u=t._valueMin();break;case e.ui.keyCode.END:u=t._valueMax();break;case e.ui.keyCode.PAGE_UP:u=t._trimAlignValue(o+(t._valueMax()-t._valueMin())/n);break;case e.ui.keyCode.PAGE_DOWN:u=t._trimAlignValue(o-(t._valueMax()-t._valueMin())/n);break;case e.ui.keyCode.UP:case e.ui.keyCode.RIGHT:if(o===t._valueMax())return;u=t._trimAlignValue(o+a);break;case e.ui.keyCode.DOWN:case e.ui.keyCode.LEFT:if(o===t._valueMin())return;u=t._trimAlignValue(o-a)}t._slide(r,i,u)}).keyup(function(n){var r=e(this).data("index.ui-slider-handle");t._keySliding&&(t._keySliding=!1,t._stop(n,r),t._change(n,r),e(this).removeClass("ui-state-active"))}),this._refreshValue(),this._animateOff=!1},destroy:function(){return this.handles.remove(),this.range.remove(),this.element.removeClass("ui-slider ui-slider-horizontal ui-slider-vertical ui-slider-disabled ui-widget ui-widget-content ui-corner-all").removeData("slider").unbind(".slider"),this._mouseDestroy(),this},_mouseCapture:function(t){var n=this.options,r,i,s,o,u,a,f,l,c;return n.disabled?!1:(this.elementSize={width:this.element.outerWidth(),height:this.element.outerHeight()},this.elementOffset=this.element.offset(),r={x:t.pageX,y:t.pageY},i=this._normValueFromMouse(r),s=this._valueMax()-this._valueMin()+1,u=this,this.handles.each(function(t){var n=Math.abs(i-u.values(t));s>n&&(s=n,o=e(this),a=t)}),n.range===!0&&this.values(1)===n.min&&(a+=1,o=e(this.handles[a])),f=this._start(t,a),f===!1?!1:(this._mouseSliding=!0,u._handleIndex=a,o.addClass("ui-state-active").focus(),l=o.offset(),c=!e(t.target).parents().andSelf().is(".ui-slider-handle"),this._clickOffset=c?{left:0,top:0}:{left:t.pageX-l.left-o.width()/2,top:t.pageY-l.top-o.height()/2-(parseInt(o.css("borderTopWidth"),10)||0)-(parseInt(o.css("borderBottomWidth"),10)||0)+(parseInt(o.css("marginTop"),10)||0)},this.handles.hasClass("ui-state-hover")||this._slide(t,a,i),this._animateOff=!0,!0))},_mouseStart:function(e){return!0},_mouseDrag:function(e){var t={x:e.pageX,y:e.pageY},n=this._normValueFromMouse(t);return this._slide(e,this._handleIndex,n),!1},_mouseStop:function(e){return this.handles.removeClass("ui-state-active"),this._mouseSliding=!1,this._stop(e,this._handleIndex),this._change(e,this._handleIndex),this._handleIndex=null,this._clickOffset=null,this._animateOff=!1,!1},_detectOrientation:function(){this.orientation=this.options.orientation==="vertical"?"vertical":"horizontal"},_normValueFromMouse:function(e){var t,n,r,i,s;return this.orientation==="horizontal"?(t=this.elementSize.width,n=e.x-this.elementOffset.left-(this._clickOffset?this._clickOffset.left:0)):(t=this.elementSize.height,n=e.y-this.elementOffset.top-(this._clickOffset?this._clickOffset.top:0)),r=n/t,r>1&&(r=1),r<0&&(r=0),this.orientation==="vertical"&&(r=1-r),i=this._valueMax()-this._valueMin(),s=this._valueMin()+r*i,this._trimAlignValue(s)},_start:function(e,t){var n={handle:this.handles[t],value:this.value()};return this.options.values&&this.options.values.length&&(n.value=this.values(t),n.values=this.values()),this._trigger("start",e,n)},_slide:function(e,t,n){var r,i,s;this.options.values&&this.options.values.length?(r=this.values(t?0:1),this.options.values.length===2&&this.options.range===!0&&(t===0&&n>r||t===1&&n<r)&&(n=r),n!==this.values(t)&&(i=this.values(),i[t]=n,s=this._trigger("slide",e,{handle:this.handles[t],value:n,values:i}),r=this.values(t?0:1),s!==!1&&this.values(t,n,!0))):n!==this.value()&&(s=this._trigger("slide",e,{handle:this.handles[t],value:n}),s!==!1&&this.value(n))},_stop:function(e,t){var n={handle:this.handles[t],value:this.value()};this.options.values&&this.options.values.length&&(n.value=this.values(t),n.values=this.values()),this._trigger("stop",e,n)},_change:function(e,t){if(!this._keySliding&&!this._mouseSliding){var n={handle:this.handles[t],value:this.value()};this.options.values&&this.options.values.length&&(n.value=this.values(t),n.values=this.values()),this._trigger("change",e,n)}},value:function(e){if(arguments.length){this.options.value=this._trimAlignValue(e),this._refreshValue(),this._change(null,0);return}return this._value()},values:function(t,n){var r,i,s;if(arguments.length>1){this.options.values[t]=this._trimAlignValue(n),this._refreshValue(),this._change(null,t);return}if(!arguments.length)return this._values();if(!e.isArray(arguments[0]))return this.options.values&&this.options.values.length?this._values(t):this.value();r=this.options.values,i=arguments[0];for(s=0;s<r.length;s+=1)r[s]=this._trimAlignValue(i[s]),this._change(null,s);this._refreshValue()},_setOption:function(t,n){var r,i=0;e.isArray(this.options.values)&&(i=this.options.values.length),e.Widget.prototype._setOption.apply(this,arguments);switch(t){case"disabled":n?(this.handles.filter(".ui-state-focus").blur(),this.handles.removeClass("ui-state-hover"),this.handles.propAttr("disabled",!0),this.element.addClass("ui-disabled")):(this.handles.propAttr("disabled",!1),this.element.removeClass("ui-disabled"));break;case"orientation":this._detectOrientation(),this.element.removeClass("ui-slider-horizontal ui-slider-vertical").addClass("ui-slider-"+this.orientation),this._refreshValue();break;case"value":this._animateOff=!0,this._refreshValue(),this._change(null,0),this._animateOff=!1;break;case"values":this._animateOff=!0,this._refreshValue();for(r=0;r<i;r+=1)this._change(null,r);this._animateOff=!1}},_value:function(){var e=this.options.value;return e=this._trimAlignValue(e),e},_values:function(e){var t,n,r;if(arguments.length)return t=this.options.values[e],t=this._trimAlignValue(t),t;n=this.options.values.slice();for(r=0;r<n.length;r+=1)n[r]=this._trimAlignValue(n[r]);return n},_trimAlignValue:function(e){if(e<=this._valueMin())return this._valueMin();if(e>=this._valueMax())return this._valueMax();var t=this.options.step>0?this.options.step:1,n=(e-this._valueMin())%t,r=e-n;return Math.abs(n)*2>=t&&(r+=n>0?t:-t),parseFloat(r.toFixed(5))},_valueMin:function(){return this.options.min},_valueMax:function(){return this.options.max},_refreshValue:function(){var t=this.options.range,n=this.options,r=this,i=this._animateOff?!1:n.animate,s,o={},u,a,f,l;this.options.values&&this.options.values.length?this.handles.each(function(t,a){s=(r.values(t)-r._valueMin())/(r._valueMax()-r._valueMin())*100,o[r.orientation==="horizontal"?"left":"bottom"]=s+"%",e(this).stop(1,1)[i?"animate":"css"](o,n.animate),r.options.range===!0&&(r.orientation==="horizontal"?(t===0&&r.range.stop(1,1)[i?"animate":"css"]({left:s+"%"},n.animate),t===1&&r.range[i?"animate":"css"]({width:s-u+"%"},{queue:!1,duration:n.animate})):(t===0&&r.range.stop(1,1)[i?"animate":"css"]({bottom:s+"%"},n.animate),t===1&&r.range[i?"animate":"css"]({height:s-u+"%"},{queue:!1,duration:n.animate}))),u=s}):(a=this.value(),f=this._valueMin(),l=this._valueMax(),s=l!==f?(a-f)/(l-f)*100:0,o[r.orientation==="horizontal"?"left":"bottom"]=s+"%",this.handle.stop(1,1)[i?"animate":"css"](o,n.animate),t==="min"&&this.orientation==="horizontal"&&this.range.stop(1,1)[i?"animate":"css"]({width:s+"%"},n.animate),t==="max"&&this.orientation==="horizontal"&&this.range[i?"animate":"css"]({width:100-s+"%"},{queue:!1,duration:n.animate}),t==="min"&&this.orientation==="vertical"&&this.range.stop(1,1)[i?"animate":"css"]({height:s+"%"},n.animate),t==="max"&&this.orientation==="vertical"&&this.range[i?"animate":"css"]({height:100-s+"%"},{queue:!1,duration:n.animate}))}}),e.extend(e.ui.slider,{version:"@VERSION"})}(jQuery),function(e,t){function i(){return++n}function s(){return++r}var n=0,r=0;e.widget("ui.tabs",{options:{add:null,ajaxOptions:null,cache:!1,cookie:null,collapsible:!1,disable:null,disabled:[],enable:null,event:"click",fx:null,idPrefix:"ui-tabs-",load:null,panelTemplate:"<div></div>",remove:null,select:null,show:null,spinner:"<em>Loading&#8230;</em>",tabTemplate:"<li><a href='#{href}'><span>#{label}</span></a></li>"},_create:function(){this._tabify(!0)},_setOption:function(e,t){if(e=="selected"){if(this.options.collapsible&&t==this.options.selected)return;this.select(t)}else this.options[e]=t,this._tabify()},_tabId:function(e){return e.title&&e.title.replace(/\s/g,"_").replace(/[^\w\u00c0-\uFFFF-]/g,"")||this.options.idPrefix+i()},_sanitizeSelector:function(e){return e.replace(/:/g,"\\:")},_cookie:function(){var t=this.cookie||(this.cookie=this.options.cookie.name||"ui-tabs-"+s());return e.cookie.apply(null,[t].concat(e.makeArray(arguments)))},_ui:function(e,t){return{tab:e,panel:t,index:this.anchors.index(e)}},_cleanup:function(){this.lis.filter(".ui-state-processing").removeClass("ui-state-processing").find("span:data(label.tabs)").each(function(){var t=e(this);t.html(t.data("label.tabs")).removeData("label.tabs")})},_tabify:function(n){function h(t,n){t.css("display",""),!e.support.opacity&&n.opacity&&t[0].style.removeAttribute("filter")}var r=this,i=this.options,s=/^#.+/;this.list=this.element.find("ol,ul").eq(0),this.lis=e(" > li:has(a[href])",this.list),this.anchors=this.lis.map(function(){return e("a",this)[0]}),this.panels=e([]),this.anchors.each(function(t,n){var o=e(n).attr("href"),u=o.split("#")[0],a;u&&(u===location.toString().split("#")[0]||(a=e("base")[0])&&u===a.href)&&(o=n.hash,n.href=o);if(s.test(o))r.panels=r.panels.add(r.element.find(r._sanitizeSelector(o)));else if(o&&o!=="#"){e.data(n,"href.tabs",o),e.data(n,"load.tabs",o.replace(/#.*$/,""));var f=r._tabId(n);n.href="#"+f;var l=r.element.find("#"+f);l.length||(l=e(i.panelTemplate).attr("id",f).addClass("ui-tabs-panel ui-widget-content ui-corner-bottom").insertAfter(r.panels[t-1]||r.list),l.data("destroy.tabs",!0)),r.panels=r.panels.add(l)}else i.disabled.push(t)}),n?(this.element.addClass("ui-tabs ui-widget ui-widget-content ui-corner-all"),this.list.addClass("ui-tabs-nav ui-helper-reset ui-helper-clearfix ui-widget-header ui-corner-all"),this.lis.addClass("ui-state-default ui-corner-top"),this.panels.addClass("ui-tabs-panel ui-widget-content ui-corner-bottom"),i.selected===t?(location.hash&&this.anchors.each(function(e,t){if(t.hash==location.hash)return i.selected=e,!1}),typeof i.selected!="number"&&i.cookie&&(i.selected=parseInt(r._cookie(),10)),typeof i.selected!="number"&&this.lis.filter(".ui-tabs-selected").length&&(i.selected=this.lis.index(this.lis.filter(".ui-tabs-selected"))),i.selected=i.selected||(this.lis.length?0:-1)):i.selected===null&&(i.selected=-1),i.selected=i.selected>=0&&this.anchors[i.selected]||i.selected<0?i.selected:0,i.disabled=e.unique(i.disabled.concat(e.map(this.lis.filter(".ui-state-disabled"),function(e,t){return r.lis.index(e)}))).sort(),e.inArray(i.selected,i.disabled)!=-1&&i.disabled.splice(e.inArray(i.selected,i.disabled),1),this.panels.addClass("ui-tabs-hide"),this.lis.removeClass("ui-tabs-selected ui-state-active"),i.selected>=0&&this.anchors.length&&(r.element.find(r._sanitizeSelector(r.anchors[i.selected].hash)).removeClass("ui-tabs-hide"),this.lis.eq(i.selected).addClass("ui-tabs-selected ui-state-active"),r.element.queue("tabs",function(){r._trigger("show",null,r._ui(r.anchors[i.selected],r.element.find(r._sanitizeSelector(r.anchors[i.selected].hash))[0]))}),this.load(i.selected)),e(window).bind("unload",function(){r.lis.add(r.anchors).unbind(".tabs"),r.lis=r.anchors=r.panels=null})):i.selected=this.lis.index(this.lis.filter(".ui-tabs-selected")),this.element[i.collapsible?"addClass":"removeClass"]("ui-tabs-collapsible"),i.cookie&&this._cookie(i.selected,i.cookie);for(var o=0,u;u=this.lis[o];o++)e(u)[e.inArray(o,i.disabled)!=-1&&!e(u).hasClass("ui-tabs-selected")?"addClass":"removeClass"]("ui-state-disabled");i.cache===!1&&this.anchors.removeData("cache.tabs"),this.lis.add(this.anchors).unbind(".tabs");if(i.event!=="mouseover"){var a=function(e,t){t.is(":not(.ui-state-disabled)")&&t.addClass("ui-state-"+e)},f=function(e,t){t.removeClass("ui-state-"+e)};this.lis.bind("mouseover.tabs",function(){a("hover",e(this))}),this.lis.bind("mouseout.tabs",function(){f("hover",e(this))}),this.anchors.bind("focus.tabs",function(){a("focus",e(this).closest("li"))}),this.anchors.bind("blur.tabs",function(){f("focus",e(this).closest("li"))})}var l,c;i.fx&&(e.isArray(i.fx)?(l=i.fx[0],c=i.fx[1]):l=c=i.fx);var p=c?function(t,n){e(t).closest("li").addClass("ui-tabs-selected ui-state-active"),n.hide().removeClass("ui-tabs-hide").animate(c,c.duration||"normal",function(){h(n,c),r._trigger("show",null,r._ui(t,n[0]))})}:function(t,n){e(t).closest("li").addClass("ui-tabs-selected ui-state-active"),n.removeClass("ui-tabs-hide"),r._trigger("show",null,r._ui(t,n[0]))},d=l?function(e,t){t.animate(l,l.duration||"normal",function(){r.lis.removeClass("ui-tabs-selected ui-state-active"),t.addClass("ui-tabs-hide"),h(t,l),r.element.dequeue("tabs")})}:function(e,t,n){r.lis.removeClass("ui-tabs-selected ui-state-active"),t.addClass("ui-tabs-hide"),r.element.dequeue("tabs")};this.anchors.bind(i.event+".tabs",function(){var t=this,n=e(t).closest("li"),s=r.panels.filter(":not(.ui-tabs-hide)"),o=r.element.find(r._sanitizeSelector(t.hash));if(n.hasClass("ui-tabs-selected")&&!i.collapsible||n.hasClass("ui-state-disabled")||n.hasClass("ui-state-processing")||r.panels.filter(":animated").length||r._trigger("select",null,r._ui(this,o[0]))===!1)return this.blur(),!1;i.selected=r.anchors.index(this),r.abort();if(i.collapsible){if(n.hasClass("ui-tabs-selected"))return i.selected=-1,i.cookie&&r._cookie(i.selected,i.cookie),r.element.queue("tabs",function(){d(t,s)}).dequeue("tabs"),this.blur(),!1;if(!s.length)return i.cookie&&r._cookie(i.selected,i.cookie),r.element.queue("tabs",function(){p(t,o)}),r.load(r.anchors.index(this)),this.blur(),!1}i.cookie&&r._cookie(i.selected,i.cookie);if(!o.length)throw"jQuery UI Tabs: Mismatching fragment identifier.";s.length&&r.element.queue("tabs",function(){d(t,s)}),r.element.queue("tabs",function(){p(t,o)}),r.load(r.anchors.index(this)),e.browser.msie&&this.blur()}),this.anchors.bind("click.tabs",function(){return!1})},_getIndex:function(e){return typeof e=="string"&&(e=this.anchors.index(this.anchors.filter("[href$='"+e+"']"))),e},destroy:function(){var t=this.options;return this.abort(),this.element.unbind(".tabs").removeClass("ui-tabs ui-widget ui-widget-content ui-corner-all ui-tabs-collapsible").removeData("tabs"),this.list.removeClass("ui-tabs-nav ui-helper-reset ui-helper-clearfix ui-widget-header ui-corner-all"),this.anchors.each(function(){var t=e.data(this,"href.tabs");t&&(this.href=t);var n=e(this).unbind(".tabs");e.each(["href","load","cache"],function(e,t){n.removeData(t+".tabs")})}),this.lis.unbind(".tabs").add(this.panels).each(function(){e.data(this,"destroy.tabs")?e(this).remove():e(this).removeClass(["ui-state-default","ui-corner-top","ui-tabs-selected","ui-state-active","ui-state-hover","ui-state-focus","ui-state-disabled","ui-tabs-panel","ui-widget-content","ui-corner-bottom","ui-tabs-hide"].join(" "))}),t.cookie&&this._cookie(null,t.cookie),this},add:function(n,r,i){i===t&&(i=this.anchors.length);var s=this,o=this.options,u=e(o.tabTemplate.replace(/#\{href\}/g,n).replace(/#\{label\}/g,r)),a=n.indexOf("#")?this._tabId(e("a",u)[0]):n.replace("#","");u.addClass("ui-state-default ui-corner-top").data("destroy.tabs",!0);var f=s.element.find("#"+a);return f.length||(f=e(o.panelTemplate).attr("id",a).data("destroy.tabs",!0)),f.addClass("ui-tabs-panel ui-widget-content ui-corner-bottom ui-tabs-hide"),i>=this.lis.length?(u.appendTo(this.list),f.appendTo(this.list[0].parentNode)):(u.insertBefore(this.lis[i]),f.insertBefore(this.panels[i])),o.disabled=e.map(o.disabled,function(e,t){return e>=i?++e:e}),this._tabify(),this.anchors.length==1&&(o.selected=0,u.addClass("ui-tabs-selected ui-state-active"),f.removeClass("ui-tabs-hide"),this.element.queue("tabs",function(){s._trigger("show",null,s._ui(s.anchors[0],s.panels[0]))}),this.load(0)),this._trigger("add",null,this._ui(this.anchors[i],this.panels[i])),this},remove:function(t){t=this._getIndex(t);var n=this.options,r=this.lis.eq(t).remove(),i=this.panels.eq(t).remove();return r.hasClass("ui-tabs-selected")&&this.anchors.length>1&&this.select(t+(t+1<this.anchors.length?1:-1)),n.disabled=e.map(e.grep(n.disabled,function(e,n){return e!=t}),function(e,n){return e>=t?--e:e}),this._tabify(),this._trigger("remove",null,this._ui(r.find("a")[0],i[0])),this},enable:function(t){t=this._getIndex(t);var n=this.options;if(e.inArray(t,n.disabled)==-1)return;return this.lis.eq(t).removeClass("ui-state-disabled"),n.disabled=e.grep(n.disabled,function(e,n){return e!=t}),this._trigger("enable",null,this._ui(this.anchors[t],this.panels[t])),this},disable:function(e){e=this._getIndex(e);var t=this,n=this.options;return e!=n.selected&&(this.lis.eq(e).addClass("ui-state-disabled"),n.disabled.push(e),n.disabled.sort(),this._trigger("disable",null,this._ui(this.anchors[e],this.panels[e]))),this},select:function(e){e=this._getIndex(e);if(e==-1){if(!this.options.collapsible||this.options.selected==-1)return this;e=this.options.selected}return this.anchors.eq(e).trigger(this.options.event+".tabs"),this},load:function(t){t=this._getIndex(t);var n=this,r=this.options,i=this.anchors.eq(t)[0],s=e.data(i,"load.tabs");this.abort();if(!s||this.element.queue("tabs").length!==0&&e.data(i,"cache.tabs")){this.element.dequeue("tabs");return}this.lis.eq(t).addClass("ui-state-processing");if(r.spinner){var o=e("span",i);o.data("label.tabs",o.html()).html(r.spinner)}return this.xhr=e.ajax(e.extend({},r.ajaxOptions,{url:s,success:function(s,o){n.element.find(n._sanitizeSelector(i.hash)).html(s),n._cleanup(),r.cache&&e.data(i,"cache.tabs",!0),n._trigger("load",null,n._ui(n.anchors[t],n.panels[t]));try{r.ajaxOptions.success(s,o)}catch(u){}},error:function(e,s,o){n._cleanup(),n._trigger("load",null,n._ui(n.anchors[t],n.panels[t]));try{r.ajaxOptions.error(e,s,t,i)}catch(o){}}})),n.element.dequeue("tabs"),this},abort:function(){return this.element.queue([]),this.panels.stop(!1,!0),this.element.queue("tabs",this.element.queue("tabs").splice(-2,2)),this.xhr&&(this.xhr.abort(),delete this.xhr),this._cleanup(),this},url:function(e,t){return this.anchors.eq(e).removeData("cache.tabs").data("load.tabs",t),this},length:function(){return this.anchors.length}}),e.extend(e.ui.tabs,{version:"@VERSION"}),e.extend(e.ui.tabs.prototype,{rotation:null,rotate:function(e,t){var n=this,r=this.options,i=n._rotate||(n._rotate=function(t){clearTimeout(n.rotation),n.rotation=setTimeout(function(){var e=r.selected;n.select(++e<n.anchors.length?e:0)},e),t&&t.stopPropagation()}),s=n._unrotate||(n._unrotate=t?function(e){i()}:function(e){e.clientX&&n.rotate(null)});return e?(this.element.bind("tabsshow",i),this.anchors.bind(r.event+".tabs",s),i()):(clearTimeout(n.rotation),this.element.unbind("tabsshow",i),this.anchors.unbind(r.event+".tabs",s),delete this._rotate,delete this._unrotate),this}})}(jQuery),define("jqueryui",function(){}),$.fn.centerInClient=function(e){var t={forceAbsolute:!1,container:window,completeHandler:null};return $.extend(t,e),this.each(function(e){var n=$(this),r=$(t.container),i=t.container==window;t.forceAbsolute&&(i?n.remove().appendTo("body"):n.remove().appendTo(r.get(0))),n.css("position","absolute");var s=i?2:1.8,o=(i?r.width():r.outerWidth())/2-n.outerWidth()/2,u=(i?r.height():r.outerHeight())/s-n.outerHeight()/2;n.css("left",o+r.scrollLeft()),n.css("top",u+r.scrollTop()),t.completeHandler&&t.completeHandler(this)})},define("jquerycenter",function(){}),define("use!jquery",["jquery","jqueryui","jquerycenter"],function(){return window.$}),define("models/song",["underscore","use!backbone"],function(e,t){var n=t.Model.extend({defaults:{name:"",year:"",album:"",quote:"",length:""},idAttribute:"id"});return n}),function(e){function s(t){window["DOMParser"]==undefined&&window.ActiveXObject&&(DOMParser=function(){},DOMParser.prototype.parseFromString=function(e){var t=new ActiveXObject("Microsoft.XMLDOM");return t.async="false",t.loadXML(e),t});try{var n=(new DOMParser).parseFromString(t,"text/xml");if(!e.isXMLDoc(n))throw"Unable to parse XML";var r=e("parsererror",n);if(r.length==1)throw"Error: "+e(n).text()}catch(i){var s=i.name==undefined?i:i.name+": "+i.message;return e(document).trigger("xmlParseError",[s]),undefined}return n}function o(e,t,n){(e.context?jQuery(e.context):jQuery.event).trigger(t,n)}function u(t,n){var r=!1;return typeof n=="string"?e.isFunction(t.test)?t.test(n):t==n:(e.each(t,function(i,s){return n[i]===undefined?(r=!1,r):(r=!0,typeof n[i]=="object"?u(t[i],n[i]):(e.isFunction(t[i].test)?r=t[i].test(n[i]):r=t[i]==n[i],r))}),r)}function a(t,n){if(e.isFunction(t))return t(n);if(e.isFunction(t.url.test)){if(!t.url.test(n.url))return null}else{var r=t.url.indexOf("*");if(t.url!==n.url&&r===-1||!(new RegExp(t.url.replace(/[-[\]{}()+?.,\\^$|#\s]/g,"\\$&").replace("*",".+"))).test(n.url))return null}return t.data&&n.data&&!u(t.data,n.data)?null:t&&t.type&&t.type.toLowerCase()!=n.type.toLowerCase()?null:t}function f(t,n){var r=e.extend({},e.mockjaxSettings,t);r.log&&e.isFunction(r.log)&&r.log("MOCK "+n.type.toUpperCase()+": "+n.url,e.extend({},n))}function l(n,r,i){var o=function(t){return function(){return function(){this.status=n.status,this.statusText=n.statusText,this.readyState=4,e.isFunction(n.response)&&n.response(i),r.dataType=="json"&&typeof n.responseText=="object"?this.responseText=JSON.stringify(n.responseText):r.dataType=="xml"?typeof n.responseXML=="string"?this.responseXML=s(n.responseXML):this.responseXML=n.responseXML:this.responseText=n.responseText;if(typeof n.status=="number"||typeof n.status=="string")this.status=n.status;typeof n.statusText=="string"&&(this.statusText=n.statusText),e.isFunction(this.onreadystatechange)?(n.isTimeout&&(this.status=-1),this.onreadystatechange(n.isTimeout?"timeout":undefined)):n.isTimeout&&(this.status=-1)}.apply(t)}}(this);n.proxy?t({global:!1,url:n.proxy,type:n.proxyType,data:n.data,dataType:r.dataType==="script"?"text/plain":r.dataType,complete:function(e,t){n.responseXML=e.responseXML,n.responseText=e.responseText,n.status=e.status,n.statusText=e.statusText,this.responseTimer=setTimeout(o,n.responseTime||0)}}):r.async===!1?o():this.responseTimer=setTimeout(o,n.responseTime||50)}function c(t,n,r,i){return t=e.extend({},e.mockjaxSettings,t),typeof t.headers=="undefined"&&(t.headers={}),t.contentType&&(t.headers["content-type"]=t.contentType),{status:t.status,statusText:t.statusText,readyState:1,open:function(){},send:function(){i.fired=!0,l.call(this,t,n,r)},abort:function(){clearTimeout(this.responseTimer)},setRequestHeader:function(e,n){t.headers[e]=n},getResponseHeader:function(e){if(t.headers&&t.headers[e])return t.headers[e];if(e.toLowerCase()=="last-modified")return t.lastModified||(new Date).toString();if(e.toLowerCase()=="etag")return t.etag||"";if(e.toLowerCase()=="content-type")return t.contentType||"text/plain"},getAllResponseHeaders:function(){var n="";return e.each(t.headers,function(e,t){n+=e+": "+t+"\n"}),n}}}function h(e,t,n){p(e),e.dataType="json";if(e.data&&r.test(e.data)||r.test(e.url)){v(e,t);var i=/^(\w+:)?\/\/([^\/?#]+)/,s=i.exec(e.url),o=s&&(s[1]&&s[1]!==location.protocol||s[2]!==location.host);e.dataType="script";if(e.type.toUpperCase()==="GET"&&o){var u=d(e,t,n);return u?u:!0}}return null}function p(e){if(e.type.toUpperCase()==="GET")r.test(e.url)||(e.url+=(/\?/.test(e.url)?"&":"?")+(e.jsonp||"callback")+"=?");else if(!e.data||!r.test(e.data))e.data=(e.data?e.data+"&":"")+(e.jsonp||"callback")+"=?"}function d(t,n,r){var i=r&&r.context||t,s=null;return n.response&&e.isFunction(n.response)?n.response(r):typeof n.responseText=="object"?e.globalEval("("+JSON.stringify(n.responseText)+")"):e.globalEval("("+n.responseText+")"),m(t,n),g(t,n),jQuery.Deferred&&(s=new jQuery.Deferred,typeof n.responseText=="object"?s.resolve(n.responseText):s.resolve(jQuery.parseJSON(n.responseText))),s}function v(e,t){jsonp=e.jsonpCallback||"jsonp"+i++,e.data&&(e.data=(e.data+"").replace(r,"="+jsonp+"$1")),e.url=e.url.replace(r,"="+jsonp+"$1"),window[jsonp]=window[jsonp]||function(n){data=n,m(e,t),g(e,t),window[jsonp]=undefined;try{delete window[jsonp]}catch(r){}head&&head.removeChild(script)}}function m(e,t){e.success&&e.success.call(callbackContext,t.response?t.response.toString():t.responseText||"",status,{}),e.global&&o(e,"ajaxSuccess",[{},e])}function g(e,t){e.complete&&e.complete.call(callbackContext,{},status),e.global&&o("ajaxComplete",[{},e]),e.global&&!--jQuery.active&&jQuery.event.trigger("ajaxStop")}function y(r,i){var s,o,u;typeof r=="object"?(i=r,r=undefined):i.url=r,o=jQuery.extend(!0,{},jQuery.ajaxSettings,i);for(var l=0;l<n.length;l++){if(!n[l])continue;u=a(n[l],o);if(!u)continue;f(u,o);if(o.dataType==="jsonp")if(s=h(o,u,i))return s;return u.cache=o.cache,u.timeout=o.timeout,u.global=o.global,function(n,r,i,o){s=t.call(e,e.extend(!0,{},i,{xhr:function(){return c(n,r,i,o)}}))}(u,o,i,n[l]),s}return t.apply(e,[i])}var t=e.ajax,n=[],r=/=\?(&|$)/,i=(new Date).getTime();e.extend({ajax:y}),e.mockjaxSettings={log:function(e){window.console&&window.console.log&&window.console.log(e)},status:200,statusText:"OK",responseTime:500,isTimeout:!1,contentType:"text/plain",response:"",responseText:"",responseXML:"",proxy:"",proxyType:"GET",lastModified:null,etag:"",headers:{etag:"IJF@H#@923uf8023hFO@I#H#","content-type":"text/plain"}},e.mockjax=function(e){var t=n.length;return n[t]=e,t},e.mockjaxClear=function(e){arguments.length==1?n[e]=null:n=[]},e.mockjax.handler=function(e){if(arguments.length==1)return n[e]}}(jQuery),define("mockjax",function(){}),define("collections/beastyboys",["underscore","use!backbone","models/song","mockjax"],function(e,t,n,r){$.mockjax({url:"/songs/beastyboys",dataType:"json",contentType:"text/json",responseText:[{id:1,name:"An Open Letter to NYC",year:2004,album:"An Open Letter to NYC",quote:"“Dear New York, / I know a lot has changed / Two Towers down / But you’re still in the game.”"},{id:2,name:"Skills To Pay The Bills",album:"Electric Tester",year:1992,quote:"“I’m selling sex rhymes by the pound.”"},{id:3,name:"The New Style",album:"Licensed To Ill",year:1986,quote:"“I’ve got money and juice, twin sisters in my bed / Their father had envy so I shot him in the head.”"},{id:4,name:"Professor Booty",album:"Check Your Head",year:1992,quote:"“Professor… what’s another word for pirate treasure?”"},{id:5,name:"The Move",album:"",year:0,quote:"“I don’t mean to brag / I don’t mean to boast / But I’m intercontinental when I eat French toast.”"},{id:6,name:"Get it Together",album:"Ill Communication",year:1994,quote:"“‘Cos she’s the cheese and I’m the macaroni!”"},{id:7,name:"She’s Crafty",album:"Licensed to Ill",year:1986,quote:"“The girl is crafty like ice is cold.”"},{id:8,name:"Jimmy James",album:"Check Your Head",year:1992,quote:"“People how ya doing there’s a new day dawning.”"},{id:9,name:"Body Movin’",album:"Hello Nasty",year:1998,quote:"“Like a bottle of Chateauneuf du Pape / I’m fine like wine when I start to rap.”"},{id:10,name:"Car Thief",album:"",year:0,quote:"“Buy my cheeba from the cop down the street / The only cop with the rope chain when he’s walking the beat.”"},{id:11,name:"Pass the Mic",album:"Check Your Head",year:1992,quote:"“Everybody rapping like it’s a commercial / Acting like life is a big commercial.”"},{id:12,name:"Sure Shot",album:"Ill Communication",year:1994,quote:" “I wanna say a little something that’s long overdue / The disrespect to women has got to be through.”"},{id:13,name:"Shadrach",album:"Paul's Boutique",year:1989,quote:"“If I had a penny for my thoughts I’d be a millionaire.”"},{id:14,name:"So What’cha Want",album:"Check Your Head",year:1992,quote:"“I’m as cool as a cucumber in a bowl of hot sauce.”"},{id:15,name:"Hey Ladies",album:"Paul's Boutique",year:1989,quote:" “Vincent Van Gogh go and mail that ear!”"},{id:16,name:"Paul Revere",album:"Licensed to Ill",year:1986,quote:"“I did it like this / I did it like that / I did it with a Wiffle ball bat.”"},{id:17,name:"Intergalactic",album:"Hello Nasty",year:1998,quote:"“When it comes to beats, I’m a fiend / I like my sugar with coffee and cream.”"},{id:18,name:"Root Down",album:"Ill Communication",year:1995,quote:"“The original nasal kid is doing damage!”"},{id:19,name:"Shake Your Rump",album:"Paul's Boutique",year:1989,quote:"“Running from the law, the press and the parents / Is your name Michael Diamond? / Naw, mine’s Clarence.”"},{id:20,name:"Sabotage",album:"Ill Communication",year:1994,quote:"“WHHHHHYYYYYYYY?”"}]});var i=t.Collection.extend({model:n,url:"/songs/beastyboys",initialize:function(){}});return new i}),define("modules/table",["namespace","use!jquery","use!backbone","models/song","collections/beastyboys"],function(e,t,n,r,i){var s=e.module();return s.Views.Detail=n.View.extend({template:"app/templates/detail.html",events:{"click .modal":"closeDetails"},closeDetails:function(){t(".detailmodel").hide(),t(".background").hide()},render:function(n){var r=this;e.fetchTemplate(this.template,function(e){r.el.innerHTML=e(r.model.toJSON()),t(r.el).appendTo("body"),t(".detailmodel").centerInClient({container:window,forceAbsolute:!1}),_.isFunction(n)&&n(r.el)})}}),s.Views.Tutorial=n.View.extend({template:"app/templates/table.html",className:"row tutview",events:{"dblclick .col":"openDetailMenu"},openDetailMenu:function(e,t){var n=this.collection.get(e.target.id),r=new s.Views.Detail({model:n});r.render()},initialize:function(){t(this.el).sortable({items:".col",cursor:"crosshair",containment:"parent",axis:"x",opacity:.5}),t(this.el).disableSelection(),this.collection=i},render:function(t){var n=this;e.fetchTemplate(this.template,function(e){i.fetch({success:function(){n.el.innerHTML=e({songs:i.toJSON()})}}),_.isFunction(t)&&t(n.el)})}}),s.Views.Content=n.View.extend({className:"row",template:"app/templates/about.html",render:function(n){var r=this;e.fetchTemplate(this.template,function(e){r.el.innerHTML=e(),t(r.el).appendTo("body"),_.isFunction(n)&&n(r.el)})}}),s}),require(["namespace","use!jquery","use!backbone","modules/table"],function(e,t,n,r){var i=n.Router.extend({routes:{"":"index",about:"about",contact:"contact"},index:function(){var e=this,n=new r.Views.Tutorial;n.render(function(e){t("#main").html(e)})},about:function(){var e=this,n=new r.Views.Content;n.template="app/templates/about.html",n.render(function(e){t("#main").html(e)})},contact:function(){var e=this,n=new r.Views.Content;n.template="app/templates/contact.html",n.render(function(e){t("#main").html(e)})}}),s=e.app;t(function(){s.router=new i,n.history.start({pushState:!1})})}),define("main",function(){}),require.config({deps:["main"],paths:{libs:"../assets/js/libs",plugins:"../assets/js/plugins",jquery:"../assets/js/libs/jquery",underscore:"../assets/js/libs/underscore",backbone:"../assets/js/libs/backbone",mockjax:"../assets/js/libs/jquery.mockjax",jqueryui:"../assets/js/libs/jquery-ui",jquerycenter:"../assets/js/libs/jquery.center",use:"../assets/js/plugins/use"},use:{underscore:{attach:"_"},backbone:{deps:["use!underscore","jquery"],attach:"Backbone"},jquery:{deps:["jquery","jqueryui","jquerycenter"],attach:"$"}}}),define("config",function(){})