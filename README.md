Beastie Boys Tribute with Backbone.js
==============

Name: Stephan Smith (Stephan.Smith.BC93@gmail.com)
Attribution: Thomas Davis

This zip file contains all the code for the 'Beastie Boys Tribute with Backbone.js' challenge. It is designed to run from a browser. It implements the require + backbone.js. I used the the Backbone-Tutorial github project boilerplate. (https://github.com/thomasdavis/backboneboilerplate)

Setup:
This application uses require.js so needs a web server to function. Please drop the code into either our sites folder or onto a machine where you have a web server you can configure. For development and demo purposes I have used a local DSN entry to make cloudspokes.dev the domain the the application. Attached at the root of the application is vhost file.

Comments:

To make the code readable, I have pruned and tweaked the boilerplate comments. When possible I left the comments provided by Thomas. In other places I have rewritten the comments to better assist a developer working their way thought the application. I added work flow comments and hints to the app files.

1. app/ollections/beastyboys.js
2. app/models/song.js
3. app/modules/table.js
4. app/templates/table.html
5. app/templates/detail.html
6. app/config.js
7. app/main.js
8. app/namespace.js

Where are the tests:
===============

I pruned out the Jasmine and QUnit tests from the boilerplate, as they appears to provides tests that were not relevant to event the backbone example provides in the tutorial code. Backbone.js on Require.js adds a few testing complexities that I am still working out. So not tests.

Thanks
=================
Thanks to Thomas Davis for the Backbone-Tutorial project he posted on github!

Feedback:
Any comments on structure, approach, coding standards etc would be welcome! This is my first Cloudspokes.com challenge. Bring on the backbone challenges. Getting familiar with JQuery.Mockjax was valuable.