require.config({
  deps: ["main"],

  paths: {
    // JavaScript directory paths
    libs: "../assets/js/libs",
    plugins: "../assets/js/plugins",

    // Define aliases for specific js libraries
    jquery: "../assets/js/libs/jquery",
    underscore: "../assets/js/libs/underscore",
    backbone: "../assets/js/libs/backbone",
    mockjax: "../assets/js/libs/jquery.mockjax",
    jqueryui: "../assets/js/libs/jquery-ui",
    jquerycenter: "../assets/js/libs/jquery.center",

    // Shim Plugin
    use: "../assets/js/plugins/use"
  },

  // Use the following to define library groupings, for use
  // by other require elements to include modules that map
  // to the same namespace.
  use: {
    underscore: {
      attach: "_"
    },
    backbone: {
      deps: ["use!underscore", "jquery" ],
      attach: "Backbone"
    },
    jquery: {
      deps: ["jquery", "jqueryui", "jquerycenter" ],
      attach: "$"
    }
  }
});
