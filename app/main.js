require([
  "namespace",
  "use!jquery",
  "use!backbone",
  "modules/table"
],

function(namespace, $, Bb, Table) {

  // Defining the application router, you can attach sub routers here.
  var Router = Bb.Router.extend({
    routes: {
      "": "index"
    },

    index: function() {
      var route = this;
      var tutorial = new Table.Views.Tutorial();

      // Attach the tutorial to the DOM
      tutorial.render(function(el) {
        $("#main").html(el);
      });
    }

  });

  // Shorthand the application namespace
  var app = namespace.app;

  // Once we hit the Ready point, we can start the application
  // by defining the Router, and starting the history.
  $(function() {
    // Create an instance of the router and attach to the app namespace.
    app.router = new Router();

    // Finally we need to start the history and enable History API for browsers
    // that support it. The pushState is optional.
    Bb.history.start({ pushState: false });
  });

});
