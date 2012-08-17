this['JST'] = this['JST'] || {};

this['JST']['app/templates/about.html'] = function(obj){
var __p='';var print=function(){__p+=Array.prototype.join.call(arguments, '')};
with(obj||{}){
__p+='\n<h1>The Sauce</h1>\n\n<p>\n  This code was written for a <a href="http://www.cloudspokes.com/challenges/1493" target="_blank">Cloudspokes.com backbone.js</a> contest. The requirements\n  were to create a backbone.js demostration using Beasty Boys songs information and\n  the <a href="https://github.com/appendto/jquery-mockjax/" target="_blank">JQuery Mockjax library</a>. Below is summary of the libraries and solutions I rolled together\n  to meet the requirements. \n</p>\n\n<p>\n  The following is an outline of the tools and patterns I used to build this project. I have\n  moved on to build larger bb projects, but have found that this was a great starting point and\n  have returned to this code a number of time to refresh my memory.\n\n</p>\n\n<hr>\n\n<p>\n  <img src="/assets/img/backbone.png" width="200" align="left" style="padding: 10px; border:1px solid #DFDFDF; margin: 0 20px 10px 0;"><a href="http://backbonejs.org/" target="_blank"><b>Backbone.js</b></a> v0.9.2 - \n  This is a javascript MVC library created by the developers at DocumentCloud. It provides a bare \'bones\' setup of model, collection, view and router \'classes\'.\n</p>\n\n<hr>\n\n<p>\n  <b><a href="https://github.com/appendto/jquery-mockjax" target="_blank">JQuery Mockjax library</a></b>\n  (from <a href="http://appendto.com">appendTo</a>)\n  This is a jquery plugin that provides a prototype level set of features that allow a developer \n  to mockup end point API data and calls. We have found this to be very useful when the structure \n  of an API is not finalized, but front end UI feature are needed. Using a mock setup of APIs can \n  really help speed up the development and testing when started in the browser.\n</p> \n\n<hr>\n\n<p>\n  <img src="/assets/img/requirejs.png" width="100" align="right" style="padding: 10px; border:1px solid #DFDFDF; margin: 0 20px 10px 20px;"> \n\n  <b><a href="http://requirejs.org/" target="_blank">Require.js</a></b>\n  This was my first real go at getting require.js and the AMD pattern into\n  practice. Getting familiar with the inner working of require was great,\n  as it helped get my code production ready. \n</p>\n\n<hr>\n\n<p>\n  <b><a href="http://gruntjs.com/" target="_blank">Grunt.js</a></b>\n  This is great library + build tool that makes the special sauce of \n  backbone, require and twitter work well together. It worth the time\n  to explore, as it will help speed up your code and roll outs. It is \n  worth noting that grunt handles a lot of the everyday development and\n  deloyment tasks, the following project makes it backbone friendly.\n</p>\n\n<hr>\n\n<p>\n  <b><a href="https://github.com/backbone-boilerplate/grunt-bbb" target="_blank">Backbone for Grunt (grunt-bbb)</a></b>\n  This library extends the grunt.js task pattern to provide backbone.js \n  specific tools for setting up modules, require.js build tasks and \n  examples. While it took a while to get right, as the documentation assumes\n  a lot for someone new to require.js, this pattern makes dev-to-release\n  work much easier and stable. \n\n</p>\n\n<p>\n  <b>Common commands:</b><br>\n  <code>bbb release</code> - runs a full lint + jst + requirejs + concat + min + mincss to a code base.<br>\n  <code>bbb server:release</code> - provides a fast node.js local dev setup of the a projects distribution\n  code.\n</p>\n\n<hr>\n\n<p>\n  <b><a href="http://www.west-wind.com/weblog/posts/2008/Aug/21/A-simple-jQuery-Client-Centering-Plugin" target="_blank">JQuery CenterInClient</a></b>\n  This is a jquery plugin that makes it easy to center a div within \n  a container. Thanks to Rick Strahl for a helpful blog. This feature will\n  be removed so that the twitter-bootstrap can handle the modal content. \n</p>\n\n<hr>\n\n<p>\n  <b><a href="http://twitter.github.com/bootstrap/" target="_blank">Twitter Bootstrap</a></b>\n  As a developer, I really appreciate a project that makes my normally developer-ugly web projects look nice and pretty. I tip my hat to the team that put this together! \n</p>\n\n<hr>\n\n<p>\n  <img src="/assets/img/heroku.png" align="left" style="padding: 10px; border:1px solid #DFDFDF; margin: 0 20px 10px 0;"> <b><a href="http://heroku.com/" target="_blank">Heroku + Node.js</a></b>\n  As a developer, I really appreciate a project that makes my normally developer-ugly web projects look nice and pretty. I tip my hat to the team that put this together! \n</p>\n';
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
__p+='\n\n<h1>Backbone.js - Cloudspokes Beasty Boys Tribute</h1>\n  \n<p class="span10">This is a short code challenge offered by Cloudspokes.com in May of 2012.</p>\n\n<p class="span10">This is an example backbone.js application, built for the Cloudspokes.com \n   code challenge in 2012. This example use Require.js, MockJax, Backbone.js\n   and jQuery. The base boilerplate is a backbone.js example provides by Thomas\n   Davis. Moving from a basic backbone.js to a production ready code base requires\n   some planning and code structure. The require.js project helps with this \n   coding pattern.\n</p>\n\n<div class="span10" style="color: gray; margin-bottom: 10px;font-size: 12px;">\n   <i>Double Click on Any Item to see details.</i>\n</div>\n\n<div id="tablegrid" >\n   ';
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
;__p+='\n</div>\n';
}
return __p;
};