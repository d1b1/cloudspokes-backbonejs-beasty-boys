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
      "": "index",
      "about": "about",
      "contact": "contact"
    },

    index: function() {
      var route = this;
      var tutorial = new Table.Views.Tutorial();

      // Attach the tutorial to the DOM
      tutorial.render(function(el) {
        $("#main").html(el);
      });
    },

    about: function() {
      var route = this;
      var content = new Table.Views.Content();

      content.template = "app/templates/about.html";

      // Attach the tutorial to the DOM
      content.render(function(el) {
        $("#main").html(el);
      });
    },

    contact: function() {
      var route = this;
      var content = new Table.Views.Content();

      content.template = "app/templates/contact.html";

      // Attach the tutorial to the DOM
      content.render(function(el) {
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
