module.exports = function(grunt) {

  grunt.initConfig({

    lint: {
      files: [
        "app/**/*.js"
      ]
    }

  });

  grunt.registerTask("default", "lint");

};
