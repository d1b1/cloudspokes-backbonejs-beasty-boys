define([
 'underscore', 
 'use!backbone'
 ], 
 function(_, Bb) {

  var Song = Bb.Model.extend({

    defaults: {
      name: '',
      year: '',
      album: '',
      quote: '',
      length: ''
    },

    // This attribute defines the model key that 
    // will be used to provides the unique identifier

    idAttribute: "id"

  });

  return Song;
});