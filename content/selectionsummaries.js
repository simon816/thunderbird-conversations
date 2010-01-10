/* This file modifies threadsummaries.js by overriding a large part of the
 * original code (mainly ThreadSummary.summarize). Our functions are the result
 * of incremental modifications to the original ones, so that we can backport
 * the changes from main Thunderbird code more easily.
 *
 * Original comments are C++-style, mine are C-style.
 *
 * The Original Code is multiple message preview pane
 *
 * The Initial Developer of the Original Code is
 *   Mozilla Messaging
 * Portions created by the Initial Developer are Copyright (C) 2009
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   David Ascher <dascher@mozillamessaging.com>
 *   Jonathan Protzenko <jonathan.protzenko@gmail.com>
 *
 * */

/* That's for event handlers */
var gconversation = {
  on_load_thread: null,
  on_load_thread_tab: null
};

/* That's for global namespace pollution + because we need the document's
 * <stringbundle> to be accessible. */
document.addEventListener("load", function () {
  const Ci = Components.interfaces;
  const Cc = Components.classes;
  /* Various magic values */
  const nsMsgViewIndex_None       = 0xffffffff;
  /* from mailnews/base/public/nsMsgFolderFlags.idl */
  const nsMsgFolderFlags_SentMail = 0x00000200;
  const nsMsgFolderFlags_Archive  = 0x00004000;
  const prefs = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefService).getBranch("gconversation.");
  const txttohtmlconv = Cc["@mozilla.org/txttohtmlconv;1"].createInstance(Ci.mozITXTToHTMLConv);
  const stringBundle = document.getElementById("gconv-string-bundle");

  /* Preferences are loaded once and then observed */
  let g_prefs = {};
  g_prefs["monospaced"] = prefs.getBoolPref("monospaced");
  g_prefs["hide_quote_length"] = prefs.getIntPref("hide_quote_length");
  g_prefs["fold_rule"] = prefs.getCharPref("fold_rule");

  let myPrefObserver = {
    register: function () {
      prefs.QueryInterface(Components.interfaces.nsIPrefBranch2);
      prefs.addObserver("", this, false);
    },

    unregister: function () {
      if (!prefs) return;
        prefs.removeObserver("", this);
    },

    observe: function (aSubject, aTopic, aData) {
      if (aTopic != "nsPref:changed") return;
      switch (aData) {
        case "monospaced":
          g_prefs["monospaced"] = prefs.getBoolPref("monospaced");
          break;
        case "hide_quote_length":
          g_prefs["hide_quote_length"] = prefs.getIntPref("hide_quote_length");
          break;
        case "fold_rule":
          g_prefs["fold_rule"] = prefs.getIntPref("fold_rule");
          break;
      }
    }
  };
  myPrefObserver.register();

  /* Do a "old-style" retrieval of a message's body given its nsIMsgDBHdr. This
   * is useful when MsgHdrToMimeMessage fails. */
  function getMessageBody(aMessageHeader, aStripHtml) {  
    let messenger = Cc["@mozilla.org/messenger;1"].createInstance(Ci.nsIMessenger);  
    let listener = Cc["@mozilla.org/network/sync-stream-listener;1"].createInstance(Ci.nsISyncStreamListener);  
    let uri = aMessageHeader.folder.getUriForMsg(aMessageHeader);  
    messenger.messageServiceFromURI(uri).streamMessage(uri, listener, null, null, false, "");  
    let folder = aMessageHeader.folder;  
    /*
     * AUTF8String getMsgTextFromStream(in nsIInputStream aStream, in ACString aCharset,
                                        in unsigned long aBytesToRead, in unsigned long aMaxOutputLen, 
                                        in boolean aCompressQuotes, in boolean aStripHTMLTags,
                                        out ACString aContentType);
    */
    return folder.getMsgTextFromStream(listener.inputStream, aMessageHeader.Charset, 65536, 32768, false, aStripHtml, { });  
  }  

  /* In the case of GMail accounts, several messages with the same Message-Id
   * header will be returned when we search for all message related to the
   * conversation we will display. We have multiple alternatives to choose from,
   * so prefer :
   * - the message that's in the current folder
   * - the message that's in the "Sent" folder (GMail sent messages also appear
   *   in "All Mail")
   * - the message that's not in the Archives
   */
  function selectRightMessage(similar) {
    let msgHdr;
    /* NB: this will return false for the "Inbox" Smart Folder for instance */
      for each (let m in similar) {
        if (gDBView.msgFolder && m.folderMessage.folder.URI == gDBView.msgFolder.URI) {
          dump("Found a corresponding message in the current folder\n");
          msgHdr = m;
          break;
        }
      }
      if (!msgHdr) {
        for each (let m in similar) {
          if (m.folderMessage.folder.getFlag(nsMsgFolderFlags_SentMail)) {
            dump("Found a corresponding message in the sent folder\n");
            msgHdr = m;
            break;
          }
        }
      }
      if (!msgHdr) {
        for each (let m in similar) {
          if (!m.folderMessage.folder.getFlag(nsMsgFolderFlags_Archive)) {
            dump("Found a corresponding message that's not in an Archive folder\n");
            msgHdr = m;
            break;
          }
        }
      }
      if (!msgHdr)
        msgHdr = similar[0];
      return msgHdr;
  }

  /* We override the usual ThreadSummary class to provide our own. Our own
   * displays full messages, plus other extra features */
  ThreadSummary = function (messages) {
    /* Structure of the parameter:
     * messages =
     *  [
     *    [GlodaMessage1, GlodaMessage2, ... (all share the same MessageId Header],
     *    [Same for 2nd message in thread]
     *  ]
     * */
    this._msgHdrs = messages;
  }

  ThreadSummary.prototype = {
    __proto__: MultiMessageSummary.prototype,

    summarize: function() {

      const predefinedColors = ["#204a87", "#5c3566", "#8f5902", "#a40000", "#c4a000", "#4e9a06", "#ce5c00"]; 
      let gColorCount = 0;
      function newColor() {
        if (gColorCount < predefinedColors.length) {
          return predefinedColors[gColorCount++];
        } else {
          let rand = function () Math.round(Math.random()*255);
          let r = rand();
          let g = rand();
          let b = rand();
          return "rgb("+r+","+g+","+b+")";
        }
      }

      this._msgNodes = {};

      let htmlpane = document.getElementById('multimessage');

      /* Fill the heading */
      let firstMsgHdr = this._msgHdrs[0][0].folderMessage;
      let numMessages = this._msgHdrs.length;
      let subject = (firstMsgHdr.mime2DecodedSubject || gSelectionSummaryStrings["noSubject"])
         + " "
         + PluralForm.get(numMessages, gSelectionSummaryStrings["Nmessages"]).replace('#1', numMessages);
      let heading = htmlpane.contentDocument.getElementById('heading');
      heading.setAttribute("class", "heading");
      heading.textContent = subject;

      /* Remove messages leftover from a previous conversation */
      let messagesElt = htmlpane.contentDocument.getElementById('messagelist');
      while (messagesElt.firstChild)
        messagesElt.removeChild(messagesElt.firstChild);

      /* Useful for stripping the email from mime2DecodedAuthor for instance */
      let headerParser = Cc["@mozilla.org/messenger/headerparser;1"].getService(Ci.nsIMsgHeaderParser);
      let count = 0;
      const MAX_THREADS = 100;
      const SNIPPET_LENGTH = 300;
      let maxCountExceeded = false;
      let id2color = {};
      for (let i = 0; i < numMessages; ++i) {
        count += 1;
        if (count > MAX_THREADS) {
          maxCountExceeded = true;
          break;
        }

        let msgHdr = selectRightMessage(this._msgHdrs[i]).folderMessage;

        let msg_classes = "message ";
        if (!msgHdr.isRead)
          msg_classes += " unread";
        if (msgHdr.isFlagged)
          msg_classes += " starred";

        let senderName = headerParser.extractHeaderAddressName(msgHdr.mime2DecodedAuthor);
        let date = makeFriendlyDateAgo(new Date(msgHdr.date/1000));

        /* The snippet class really has a counter-intuitive name but that allows
         * us to keep the style from the original multimessageview.css without
         * rewriting everything */
        let msgContents = <div class="row">
                            <div class="star"/>
                            <div class="header">
                              <div class="wrappedsender">
                                <div class="sender link">{senderName}</div>
                                <div class="date">{date}</div>
                                <div class="tags"></div>
                              </div>
                              <div class="snippet fullmsg" style="display: none"></div>
                              <div class="snippet snippetmsg"></div>
                            </div>
                          </div>;

        let msgExtraContents = <div class="messagearrow">
                                 <img class="msgarrow" src="chrome://gconversation/skin/down.png" onclick="toggleMessage(event);" />
                               </div>;

        let msgNode = htmlpane.contentDocument.createElement("div");
        // innerHTML is safe here because all of the data in msgContents is
        // either generated from integers or escaped to be safe.
        msgNode.innerHTML = msgContents.toXMLString();
        msgNode.innerHTML += msgExtraContents.toXMLString();
        _mm_addClass(msgNode, msg_classes);
        messagesElt.appendChild(msgNode);

        let senderNode = msgNode.getElementsByClassName("sender")[0];
        if (id2color[senderNode.textContent])
          senderNode.style.color = id2color[senderNode.textContent];
        else
          senderNode.style.color = id2color[senderNode.textContent] = newColor();

        let fullMsgNode = msgNode.getElementsByClassName("fullmsg")[0];
        let snippetMsgNode = msgNode.getElementsByClassName("snippetmsg")[0];

        /* Style according to the preferences. Preferences have an observer, see
         * above for details. */
        if (g_prefs["monospaced"])
          fullMsgNode.style.fontFamily = "-moz-fixed";
        if ((g_prefs["fold_rule"] == "unread_and_last" && (!msgHdr.isRead || i == (numMessages - 1)))
             || g_prefs["fold_rule"] == "all") {
          snippetMsgNode.style.display = "none";
          fullMsgNode.style.display = "block";
          msgNode.getElementsByClassName("msgarrow")[0].setAttribute(
            "src",
            "chrome://gconversation/skin/up.png");
        }

        let key = msgHdr.messageKey + msgHdr.folder.URI;
        /* Fill the current message's node based on given parameters.
         * @param snippet
         *        the text that's displayed when the message is folded
         * @param body
         *        the plain/text body that will be processed to proper HTML
         * @param author
         *        (can be left out) a more refined version of the author's name
         *        but anyway meta.author is always empty so that's pretty much
         *        useless
         */ 
        let fillSnippetAndMsg = function (snippet, body, author) {
          if (author)
            senderNode.textContent = author;
          snippetMsgNode.textContent = snippet;

          /* Deal with the message's body
             First remove leading new lines */
          let j = 0;
          while (j < body.length && (body[j] == "\r" || body[j] == "\n"))
            ++j;
          body = body.substr(j, body.length - j);
          /* Then remove trailing new lines */
          j = body.length;
          while (j > 0 && (body[j-1] == "\r" || body[j-1] == "\n"))
            --j;
          body = body.substr(0, j);

          /* Iterate over the lines, feeding them in buf, and then calling
           * either flushBufQuote when leaving a quoted section, or
           * flushBufRegular when leaving a regular text section. The small
           * bufffer in buf is .join("\n")'d and goes to gbuf. We keep track
           * of indices to optimize array accesses. */
          let whatToDo = txttohtmlconv.kEntities + txttohtmlconv.kURLs
            + txttohtmlconv.kGlyphSubstitution 
            + txttohtmlconv.kStructPhrase; 
          let lines = body.split(/\r?\n|\r/g);
          let gbuf = [];
          let buf = [];
          let buf_j = 0;
          let gbuf_j = 0;
          /* When leaving a quoted section, this function is called. It adds
           * the - show quoted text - link and hides the quote if relevant */
          let flushBufQuote = function() {
            if (!buf.length)
              return;
            let divAttr = "";
            if (buf.length > g_prefs["hide_quote_length"]) {
              divAttr = "style=\"display: none;\"";
              let showquotedtext = stringBundle.getString("showquotedtext");
              let link = "<div class=\"link showhidequote\""+
                " onclick=\"toggleQuote(event);\">- "+showquotedtext+" -</div>";
              gbuf[gbuf_j++] = link;
            }
            gbuf[gbuf_j++] = "<div "+divAttr+">"+buf.join("<br />")+"</div>";
            buf = [];
            buf_j = 0;
          };
          /* This just flushes the buffer when changing sections */
          let flushBufRegular = function () {
            gbuf[gbuf_j++] = buf.join("<br />");
            buf = [];
            buf_j = 0;
          };
          let mode = 0; /* 0 = normal, 1 = in quote */
          for each (let [, line] in Iterator(lines)) {
            let p = Object();
            /* citeLevelTXT returns 0 on string ">"... which happens to be
            quite common (it's simply a new line) so we add a space to make
            sure that citeLevelTXT returns 1 on such a string */
            let quote = txttohtmlconv.citeLevelTXT(line+" ", p);
            let html = txttohtmlconv.scanTXT(line, whatToDo);
            if (quote > 0) {
              if (mode == 0)
                flushBufRegular();
              mode = 1;
            } else {
              if (mode == 1)
                flushBufQuote();
              mode = 0;
            }
            buf[buf_j++] = html;
          }
          if (mode == 1)
            flushBufQuote();
          else
            flushBufRegular();
          fullMsgNode.innerHTML += gbuf.join("");

          /* Attach the required event handlers so that links open in the
           * external browser */
          for each (let [, a] in Iterator(fullMsgNode.getElementsByTagName("a"))) {
            a.addEventListener("click", function (event) {
                return specialTabs.siteClickHandler(event, /^mailto:/);
              }, true);
          }
        };
        try {
          /* throw { result: Components.results.NS_ERROR_FAILURE }; */
          MsgHdrToMimeMessage(msgHdr, null, function(aMsgHdr, aMimeMsg) {
            if (aMimeMsg == null) // shouldn't happen, but sometimes does?
              return;
            let [snippet, meta] = mimeMsgToContentSnippetAndMeta(aMimeMsg, aMsgHdr.folder, SNIPPET_LENGTH);
            let body = aMimeMsg.coerceBodyToPlaintext(aMsgHdr.folder);
            fillSnippetAndMsg(snippet, body, meta.author);
          });
        } catch (e if e.result == Components.results.NS_ERROR_FAILURE) {
          try {
            // Offline messages generate exceptions, which is unfortunate.  When
            // that's fixed, this code should adapt. XXX
            /* --> Try to deal with that */
            let body = getMessageBody(msgHdr, true);
            let snippet = body.substring(0, SNIPPET_LENGTH-3)+"...";
            fillSnippetAndMsg(snippet, body);
            dump("Got an \"offline message\"");
          } catch (e) {
            /* Ok, that failed too... */
            fullMsgNode.textContent = "...";
            snippetMsgNode.textContent = "...";
          }
        }
        let tagsNode = msgNode.getElementsByClassName("tags")[0];
        let tags = this.getTagsForMsg(msgHdr);
        for each (let [,tag] in Iterator(tags)) {
          let tagNode = tagsNode.ownerDocument.createElement('span');
          // see tagColors.css
          let colorClass = "blc-" + this._msgTagService.getColorForKey(tag.key).substr(1);
          _mm_addClass(tagNode, "tag " + tag.tag + " " + colorClass);
          tagNode.textContent = tag.tag;
          tagsNode.appendChild(tagNode);
        }

        let sender = msgNode.getElementsByClassName("sender")[0];
        sender.msgHdr = msgHdr;
        sender.folder = msgHdr.folder;
        sender.msgKey = msgHdr.messageKey;
        sender.similar = this._msgHdrs[i];
        sender.addEventListener("click", function(e) {
          /* msgHdr is "the right message" (see the beginning of the loop) */
          let viewIndex = gFolderDisplay.view.getViewIndexForMsgHdr(this.msgHdr);
          if (viewIndex != nsMsgViewIndex_None) {
            gFolderDisplay.selectMessage(this.msgHdr);
            return;
          }

          /* msgHdr is still the best candidate for "the message we want" */
          /* selectFolder doesn't work somestimes, issue fixed in Lanikai as of 2010-01-05, see bug 536042 */
          gFolderTreeView.selectFolder(this.folder, true); 
          gFolderDisplay.selectMessage(this.msgHdr);
        }, true);

        this._msgNodes[key] = msgNode;

        messagesElt.appendChild(msgNode);
      }
      // stash somewhere so it doesn't get GC'ed
      this._glodaQueries.push(
        Gloda.getMessageCollectionForHeaders([x[0].folderMessage for each (x in this._msgHdrs)], this));
      this.notifyMaxCountExceeded(htmlpane.contentDocument, numMessages, MAX_THREADS);

      this.computeSize(htmlpane);
      htmlpane.contentDocument.defaultView.adjustHeadingSize();
    }
  };

  /* This function is the core search function. It pulls a GMail-like
   * conversation from messages aSelectedMessages, then calls k when the
   * messages have all been found */
  function pullConversation(aSelectedMessages, k) {
    try {
      q1 = Gloda.getMessageCollectionForHeaders(aSelectedMessages, {
        onItemsAdded: function (aItems) {
          let msg = aItems[0];
          //FIXME do something better...
          if (!msg)
            return;
          /*let query = Gloda.newQuery(Gloda.NOUN_MESSAGE)
          query.conversation(msg.conversation);
          //query.getCollection({*/
          q2 = msg.conversation.getMessagesCollection({
            onItemsAdded: function (aItems) {
            },
            onItemsModified: function () {},
            onItemsRemoved: function () {},
            onQueryCompleted: function (aCollection) k(aCollection, msg),
          }, true);
        },
        onItemsModified: function () {},
        onItemsRemoved: function () {}, onQueryCompleted: function (aCollection) {
        },
      }, true);
    } catch (e) {
      dump("Exception in summarizeThread" + e + "\n");
      logException(e);
      Components.utils.reportError(e);
      throw(e);
    }
  }

  /* Remove messages with the same Message-Id header from a collection.
   * Return an object with, for each message in selectedMessages, the duplicates
   * that have been found. */
  function removeDuplicates(items) {
    //let info = function (hdr) hdr.mime2DecodedAuthor+" ["+hdr.mime2DecodedSubject+"]";
    let similar = {};
    let orderedIds = [];
    for (let i = 0; i < items.length; ++i) {
      let item = items[i];
      let id = item.headerMessageID;
      if (!similar[id]) {
        similar[id] = [item];
        orderedIds.push(id);
      } else {
        similar[id].push(item);
      }
    }
    return [similar[id] for each (id in orderedIds)];
  }

  /* The summarizeThread function overwrites the default one, searches for more
   * messages, and passes them to our instance of ThreadSummary. This design is
   * more convenient as it follows Thunderbird's more closely, which allows me
   * to track changes to the ThreadSummary code in Thunderbird more easily. */
  var q1, q2;
  summarizeThread = function(aSelectedMessages) {
    if (aSelectedMessages.length == 0) {
      dump("No selected messages\n");
      return false;
    }

    pullConversation(
      aSelectedMessages,
      function (aCollection) {
        gSummary = new ThreadSummary(removeDuplicates(aCollection.items));
        gSummary.init();
        return;
      }
    );

    return true;
  };

  /* Register event handlers through the global variable */
  gconversation.on_load_thread = function() {
    if (summarizeThread(gFolderDisplay.selectedMessages))
      gMessageDisplay.singleMessageDisplay = false;
  };
  gconversation.on_load_thread_tab = function() {
    if (!gFolderDisplay.selectedMessages.length)
      return;

    pullConversation(
      gFolderDisplay.selectedMessages,
      function (aCollection, aMsg) {
        let tabmail = document.getElementById("tabmail");
        aCollection.items = [selectRightMessage(m) for each (m in removeDuplicates(aCollection.items))];
        tabmail.openTab("glodaList", {
          collection: aCollection,
          message: aMsg,
          title: aMsg.subject,
          background: false
        });
      }
    );
  };

}, true);
