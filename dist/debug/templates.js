this['JST'] = this['JST'] || {};

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
};