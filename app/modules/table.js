define([
  "namespace",
  "use!jquery",
  "use!backbone",
  "models/song",
  "collections/beastyboys"
],
function(namespace, $, Bb, Song, SongsCollection) {

  // Setup the Detail View. This will be used to show the
  // semi modal display of individual model details.

  var Table = namespace.module();

  // First we define the model level view. This View will 
  // provides the render and events required to display the
  // a single song model in the DOM.
  
  Table.Views.Detail = Bb.View.extend({

    // Define the template that require will need to fetch
    // before the view can render the song model into the DOM.

    template: "app/templates/detail.html",

    // the Events method will tell Bb to bind the closeDetails
    // method to any click on a DOM element with the class .modal. 
    // For this demo all the modal detail as well as the modal 
    // background take the event.

    events: { 
      'click .modal' : 'closeDetails'
    },

    closeDetails: function() {

      // First search the DOM and hide any element with the class
      // .detailmodel. I should tell the code to only search the 
      // view.el, but for now it works. 

      $('.detailmodel').hide();

      // Second find and hide the background div. The background
      // div acts like a click barrier for lazy-mans model feature.
      // A good next step will be to implement one of the modal
      // jquery plugins.

      $('.background').hide();

    },

    render: function(done) {
      var view = this;

      // Fetch the template, render it to the View element and call done.
      namespace.fetchTemplate(this.template, function(tmpl) {

        // Call the Detail and render on success. This will
        // use the template as well as the views model. For this
        // view, the view has a single model attached.

        view.el.innerHTML = tmpl( view.model.toJSON() );

        // Add the Detail and the Background elements to the 
        // DOM. This will append the HTML to the body of the 
        // browser. 

        $(view.el).appendTo('body');

        // Attach the .centerInClient() behavior to the .detailmodel element. This
        // will center the div so that we can scroll down and still see the div with
        // a models details.

        $(".detailmodel").centerInClient({ container: window, forceAbsolute: false });

        // If a done function is passed, call it with the element
        if (_.isFunction(done)) {
          done(view.el);
        }

      });
    }
  });

  // Define a Bb view that will receive the collection
  // and bind the models to the DOM.

  Table.Views.Tutorial = Bb.View.extend({

    // Define the template file that require will need to load 
    // before the view can render the SongsCollection into the 
    // DOM.

    template: "app/templates/table.html",

    className: "span12",

    // This method will tell Bb to bind specific methods to 
    // specific events + selectors in the Views template. When 
    // the user double clicks on the div with the class .col the
    // openDetailMenu will execute, find the related models and 
    // open the detail model.

    events: {
      'dblclick .col' : 'openDetailMenu'
    },

    // This method will extract the model from the 
    // double click event and feed it to a Bb View. 
    // There are better ways to handle this, but for
    // this project this provides a simple example
    // for how to get a specific model from a collection.

    openDetailMenu: function(evt, ui) {

      // Define a local model using the event targets ID.
      var aModel = this.collection.get(evt.target.id);

      // Define a local View and feed it the model.
      var detailView = new Table.Views.Detail({ model: aModel });

      // Call the views render function. Unlike the Table view, this
      // view will attach itself to the DOM. This is not a great pattern
      // as it can cause testing issues, but again it solves the problem
      // and provides a good working solution for a modal window.

      detailView.render();
    },

    initialize: function() {

      // This will implement the jquery UI sortable plugin to 
      // make the resulting view html sortable. 

      $(this.el).sortable({ 
        items       : ".col", 
        cursor      : 'crosshair',
        containment : "parent",
        axis        : "x",
        opacity     : 0.5
      });

      // Disable selection so that we do not get any strange mouse
      // selections as the user selects, drags and drops elements.

      $(this.el).disableSelection();

      // Attach the Songs Collection to the view. This will enable
      // the render function to use it when ready to loop over the 
      // individual song models.

      this.collection = SongsCollection;

    },

    render: function(done) {

      // Move the current this scope into a local variable. This pattern 
      // ensures that the Views variable scope will be available as 
      // the render function implements different jQuery scope changes.

      var view = this;

      // Fetch the template, render it to the View element and call done.
      // The use of this development pattern in the Backbone tutorial code
      // is a big change from the standard standalone bb app. This code is
      // needed to ensure that require has a change to load the template 
      // before rendering starts.

      namespace.fetchTemplate(this.template, function(tmpl) {
 
        // Call the Collection and render on success.
        SongsCollection.fetch({ success: function() {

            // For the purposes of this project that template is expecting
            // a object composes of song models. This approach works well 
            // for a proof of concept, but would get refactored into a more
            // subtle solution using a song specific view. Using a song view
            // would allow the developer to bind specific UI events at a 
            // model+view level. 

            view.el.innerHTML = tmpl({ songs: SongsCollection.toJSON() });
           } 
        });

        // If a done function is passed, call it with the element
        if (_.isFunction(done)) {
          done(view.el);
        }

      });
    }
  });

  Table.Views.Content = Bb.View.extend({

    className: "span12",

    template: "app/templates/about.html",

    render: function(done) {
      var view = this;

      // Fetch the template, render it to the View element and call done.
      namespace.fetchTemplate(this.template, function(tmpl) {

        view.el.innerHTML = tmpl();

        $(view.el).appendTo('body');
 
        // If a done function is passed, call it with the element
        if (_.isFunction(done)) {
          done(view.el);
        }

      });
    }
  });

  return Table;

});
