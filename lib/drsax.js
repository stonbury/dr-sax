'use strict';

var htmlparser2 = require('htmlparser2');
var defaultDialect = require('../dialect');

var last = require('./array-last');
var repeat = require('./repeat');
var rebuildTag = require('./rebuild-tag');


/**
 * DrSax is a SAX based HTML to Markdown converter.
 * @namespace DrSax
 * @method DrSax
 */
function DrSax(options){
  options = options || {};
  this.parser = new htmlparser2.Parser({
    onopentag: this.onopentag.bind(this),
    ontext: this.ontext.bind(this),
    onclosetag: this.onclosetag.bind(this)
  });

  this.tagTable = defaultDialect;

  if(Object.prototype.toString.call(options.dialect) === '[object Object]'){
    this.tagTable = options.dialect;
  }

  this.options = options || {};
  this._init();
}

/**
 * Reset the whole system.
 * @method  _init
 * @returns {object} undefined
 */
DrSax.prototype._init = function(){
  this.stack = [];
  this.splicePos = 0;
  this.spliceStack = [];
  this.listStack = [];
  this.trimNL = false;
  this.tagStack = [];
  this.ignoreClose = false;
  this.indentStack = [];
  this.tag = undefined;
};

/**
 * Write a string of HTML to the converter and receive a string of markdown back
 * @memberOf DrSax
 * @method  write
 * @param   {string} html A string containing HTML
 * @returns {string} Markdown!
 */
DrSax.prototype.write = function(html){
  this.parser.write(html.replace(/\n/g, '').replace(/\t/g, ''));
  this.parser.end();
  if(this.tagStack.length > 0){
    this._closeUnclosedTags();
  }
  // this is part of bug #19; calling `trim` on the text was removing significant
  // whitespace, so it was changed to solely remove newlines. Once we've correctly
  // assembled everything, we'll strip out non-significant whitespace since HTML ignores
  // multiple whitespace characters in a row.
  var markdown = this.stack.join('').replace(/\ \ /g, ' ').replace(/\ \n/g, '\n');
  this._init();
  return markdown;
};

DrSax.prototype._closeUnclosedTags = function(){
  var tag = this.tagStack.pop();
  while (tag){
    this.onclosetag(tag);
    tag = this.tagStack.pop();
  }
};

/**
 * What to do when you encounter an open tag
 * @memberOf DrSax
 * @method  onopentag
 * @param   {string} name The name of the tag
 * @param   {object} attrs An object with all the attrs in key/val pairs
 * @returns {object} undefined
 */
DrSax.prototype.onopentag = function(name, attrs){
  var origName = name;

  // we want to trim <li> elements so they don't generate multiple lists
  // also here we will determine what actual markdown token to insert
  // based on the parent element for the <li> that we captured above
  if(name === 'li'){
    this.trimNL = true;
    name = last(this.listStack)+'li';
  }

  this.tag = this.tagTable[name];
  if(this.tag){
    this.tagStack.push(name);
    // The wrapper tags for lists don't actually generate markdown,
    // but they influence the markdown that we're generating for their
    // child <li> members, so we need to know what is the parent tag for
    // our li
    if(name === 'ol' || name === 'ul'){
      this.listStack.push(name);
    }

    // since both <code> and <pre> can wrap each other for code blocks
    // we want to make sure we're getting rid of the <pre> tag that
    // was recorded
    if(name === 'code' && last(this.tagStack) === 'pre'){
      this.ignoreClose = true;
      this.stack.pop();
    }

    if(this.tag.block && last(this.stack) !== '\n\n' && this.stack.length > 0){
      if(this.indentStack.length === 0){
        this.stack.push('\n\n');
      } else {
        this.stack.push('\n');
      }
    }

    // Examine the indent stack. If we should be indenting, we'll need to prepare
    // the indented string correctly and insert it into the stack so that
    // the stack gets the correct data pushed into it
    if(this.indentStack.length > 0){
      var indentTag = this.tagTable[last(this.indentStack)];
      var indentText = repeat(indentTag.indent, this.indentStack.length);
      this.stack.push(indentText);
    }

    if(this.tag.indent){
      if(this.listStack.length !== 1){
        this.indentStack.push(name);
      }
    }

    if(this.tag.open.length > 0){
      if(this.spliceStack.length > 0){
        this.stack.splice(this.splicePos, 0, this.tag.open);
        ++this.splicePos;
      } else {
        this.stack.push(this.tag.open);
      }
    }

    if(this.tag.attrs){
      var keys = Object.keys(this.tag.attrs);
      var len = keys.length;
      for(var i = 0; i < len; i++){
        var key = keys[i];
        this.stack.push(this.tag.attrs[key].open);
        // if we need to get the tags containing text in here, we have to handle
        // it specially and splice it into an earlier position in the stack
        // since we don't have access to the text right now
        if(key === 'text'){
          this.splicePos = this.stack.length;
          this.spliceStack.push(name);
        // check to make sure the markdown token needs this particular attribute
        } else if (Object.keys(attrs).indexOf(key) !== -1){
          this.stack.push(attrs[key]);
        }
        this.stack.push(this.tag.attrs[key].close);
      }
    }
  } else {
    if(!this.options.stripTags){
      this.stack.push(rebuildTag(origName, attrs, 'open'));
    }
  }
};

/**
 * We have some straight up plain text. We might have to push it into the stack
 * at a higher position though...
 * @memberOf DrSax
 * @method  ontext
 * @param   {string} text Text nodes
 * @returns {object} undefined
 */
DrSax.prototype.ontext = function(text){
  // if we are in a block level tag that is being indented and
  // the text we are about to push isn't being proceded by the
  // open tag for that block level element, add it
  if(this.tag && this.tag.block && last(this.stack) !== this.tag.open && this.tag.close !== false){
    this.stack.push(this.tag.open);
  }

  // if we have to insert the text lower on the stack, this flag will be set,
  // so splice and then reset the flat
  if(this.spliceStack.length > 0){
    this.stack.splice(this.splicePos, 0, text);
    ++this.splicePos;
  } else {
    if(this.trimNL || (this.text === '\n' && last(this.stack).match(/\n$/))){
      text = text.replace(/\n/g, '');
    }
    this.stack.push(text);
  }
};

/**
 * We've reached the end of our tag, so clear all state flags, pop off the stack,
 * etc
 * @memberOf DrSax
 * @method  onclosetag
 * @param   {string} name name of the tag that is closing
 * @returns {object} undefined
 */
DrSax.prototype.onclosetag = function(name){
  var origName = name;
  // undo our listStack add since we're coming out of the list
  if(name === 'ol' || name === 'ul'){
    this.listStack.pop();
  }

  // reset the parameters for the li
  if(name === 'li'){
    this.trimNL = false;
    name = last(this.listStack)+'li';
  }

  // push a close if we aren't ignoring it and we have one to push
  var tag = this.tagTable[name];
  if(tag){
    if(!this.ignoreClose && tag.close.length > 0){
      if(this.spliceStack.length > 0){
        this.stack.splice(this.splicePos, 0, tag.close);
      } else {
        this.stack.push(tag.close);
      }
    }

    // if we're in an indentable tag, decrement the indent since we're leaving it.
    if(tag.indent){
      this.indentStack.pop();
    }

    // do we need to stop splicing tags?
    if(last(this.spliceStack) === name){
      this.spliceStack.pop();
    }

    // handle spacing appropriately for nested block level tag elements.
    if(tag.block){
      if(this.indentStack.length < 1){
        this.stack.push('\n\n');
      } else {
        this.stack.push('\n');
      }
    }

    // pull the tag off the stack, but only if it's the current tag
    if(last(this.tagStack) === name){
      this.tagStack.pop();
    }
  } else {
    if(!this.options.stripTags){
      this.stack.push(rebuildTag(origName));
    }
  }
  // always reset ignore close -- we might have wanted to ignore this one, but
  // the next one we'll have to figure out all over again
  if(this.ignoreClose){
    this.ignoreClose = false;
  }
};

module.exports = DrSax;