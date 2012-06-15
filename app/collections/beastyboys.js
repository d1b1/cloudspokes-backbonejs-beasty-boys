define([
  'underscore', 
  'use!backbone', 
  'models/song',
  'mockjax'
  ], function(_, Bb, Song, Mockjax){

  // The following will define a URL path and catch any backbone Ajax 
  // call to get song data. 

  $.mockjax({
    url: '/songs/beastyboys', 
    dataType: 'json',
    contentType: 'text/json',
    responseText: [
      { id: 1, name: "An Open Letter to NYC", year: 2004, album: "An Open Letter to NYC", quote: "“Dear New York, / I know a lot has changed / Two Towers down / But you’re still in the game.”"},
      { id: 2, name: "Skills To Pay The Bills", album: "Electric Tester", year: 1992, quote: "“I’m selling sex rhymes by the pound.”"},
      { id: 3, name: "The New Style", album: "Licensed To Ill", year: 1986, quote: "“I’ve got money and juice, twin sisters in my bed / Their father had envy so I shot him in the head.”"},
      { id: 4, name: "Professor Booty", album: "Check Your Head", year: 1992, quote: "“Professor… what’s another word for pirate treasure?”"},
      { id: 5, name: "The Move", album: "", year: 0, quote: "“I don’t mean to brag / I don’t mean to boast / But I’m intercontinental when I eat French toast.”"},
      { id: 6, name: "Get it Together", album: "Ill Communication", year: 1994, quote: "“‘Cos she’s the cheese and I’m the macaroni!”"},
      { id: 7, name: "She’s Crafty", album: "Licensed to Ill", year: 1986, quote: "“The girl is crafty like ice is cold.”"},
      { id: 8, name: "Jimmy James", album: "Check Your Head", year: 1992, quote: "“People how ya doing there’s a new day dawning.”"},
      { id: 9, name: "Body Movin’", album: "Hello Nasty", year: 1998, quote: "“Like a bottle of Chateauneuf du Pape / I’m fine like wine when I start to rap.”"},
      { id: 10, name: "Car Thief", album: "", year: 0, quote: "“Buy my cheeba from the cop down the street / The only cop with the rope chain when he’s walking the beat.”"},
      { id: 11, name: "Pass the Mic", album: "Check Your Head", year: 1992, quote: "“Everybody rapping like it’s a commercial / Acting like life is a big commercial.”"},
      { id: 12, name: "Sure Shot", album: "Ill Communication", year: 1994, quote: " “I wanna say a little something that’s long overdue / The disrespect to women has got to be through.”"},
      { id: 13, name: "Shadrach", album: "Paul's Boutique", year: 1989, quote: "“If I had a penny for my thoughts I’d be a millionaire.”"},
      { id: 14, name: "So What’cha Want", album: "Check Your Head", year: 1992, quote: "“I’m as cool as a cucumber in a bowl of hot sauce.”"},
      { id: 15, name: "Hey Ladies", album: "Paul's Boutique", year: 1989, quote: " “Vincent Van Gogh go and mail that ear!”"},
      { id: 16, name: "Paul Revere", album: "Licensed to Ill", year: 1986, quote: "“I did it like this / I did it like that / I did it with a Wiffle ball bat.”"},
      { id: 17, name: "Intergalactic", album: "Hello Nasty", year: 1998, quote: "“When it comes to beats, I’m a fiend / I like my sugar with coffee and cream.”"},
      { id: 18, name: "Root Down", album: "Ill Communication", year: 1995, quote: "“The original nasal kid is doing damage!”"},
      { id: 19, name: "Shake Your Rump", album: "Paul's Boutique", year: 1989, quote: "“Running from the law, the press and the parents / Is your name Michael Diamond? / Naw, mine’s Clarence.”"},
      { id: 20, name: "Sabotage", album: "Ill Communication", year: 1994, quote: "“WHHHHHYYYYYYYY?”"}
    ]
  });

  var SongsCollection = Bb.Collection.extend({

      model: Song,

      // Define the Collection URL endpoint. When the collection is fetched
      // backbone will use this value to make its ajax call. The preceding 
      // MockJax will intercept the jQuery .ajax call and return data.

      url: '/songs/beastyboys',

      initialize: function() {

        /*
          // If mockjax is not used, the following code can be uncommented 
          //   and used to add sample models to the collection.

          this.add( new Song({ id: 1, name: "Flying Dutchman", album: "Electric Tester", year: 2010}));
          this.add( new Song({ id: 2, name: "Test Song 101", album: "Newer Songs", year: 1988 }));
          this.add( new Song({ id: 3, name: "Black Pearl", album: "My Sheep", year: 1990 }));
          this.add( new Song({ id: 4, name: "My little Red Ballown", album: "Red Ballowns", year: 2110 }));

        */

      }

    });

    return new SongsCollection();
});