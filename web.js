var express    = require('express'),
    requestObj = require('request'),
    http       = require('http'),
    crypto     = require('crypto');

// ---------------------------------------------------

var app = express.createServer( express.logger() );

app.configure(function(){
  app.use(express.bodyParser());
  app.use(express.methodOverride());
  app.use(express.cookieParser());
});

app.configure('production', function() {
  console.log('Note: Using RequireJS assets.');

  // Paths & Files
  app.use('/assets/js/libs/', express.static(__dirname + '/dist/release/'));
  app.use('/assets/css/', express.static(__dirname + '/dist/release/'));
});

app.use(express.static( __dirname + '/' ));

var port = process.env.PORT || 4200;
app.listen(port, function() { 
  console.log("StartUp: Cloudspokes-Beasty-boys " + port ); 
});
