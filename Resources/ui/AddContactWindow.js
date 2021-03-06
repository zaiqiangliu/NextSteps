var AD = require('AppDev');
var $ = require('jquery');

module.exports = $.Window('AppDev.UI.AddContactWindow', {
    setup: function() {
        // When this class is created, initialize the static fields object
        this.fields.forEach(function(field) {
            // The database field name defaults to contact_ prepended to the field's name
            field.field = field.field || 'contact_'+field.name;
            
            field.callback = field.callback || 'change'+$.capitalize(field.name);
            field.labelId = field.label || field.name+'Label';
        });
    },
    dependencies: ['ChooseOptionWindow'],
    
    // Return the first value in the multivalue dictionary with a name in priorities
    getDefaultFromMultivalue: function(multivalue, priorities) {
        var highestPriority = { value: null, id: null };
        priorities.forEach(function(fieldName) {
            var values = multivalue[fieldName];
            if (values && values.length > 0) {
                // Use the first value
                highestPriority = {
                    value: values[0],
                    id: fieldName+':0'
                };
            }
        });
        return highestPriority;
    },
    
    // Return a new contact model instance
    createContact: function(attrs) {
        var localContact = attrs.contact_recordId === null ? null : Ti.Contacts.getPersonByID(attrs.contact_recordId);
        var firstName = '', lastName = '', nickname = '', defaultPhone = {value: null, id: null}, defaultEmail = {value: null, id: null}, note = '';
        if (localContact) {
            firstName = localContact.firstName || '';
            lastName = localContact.lastName || '';
            nickname = localContact.nickname || '';
            if (AD.Platform.isAndroid) {
                // Android does not allow access to the firstName, lastName, or nickname properties, so attempt to guess them
                var nameParts = localContact.fullName.split(' ');
                firstName = firstName || nameParts[0];
                lastName = lastName || nameParts[nameParts.length - 1];
                nickname = nickname || firstName;
            }
            defaultPhone = this.getDefaultFromMultivalue(localContact.getPhone(), ['iPhone', 'mobile', 'home']);
            defaultEmail = this.getDefaultFromMultivalue(localContact.getEmail(), ['home', 'work']);
            note = localContact.note || '';
        }
        var defaultYear = 1;
        
        // Populate the contact model fields with the new contact's information
        var baseAttrs = {
            viewer_id: AD.Viewer.viewer_id,
            contact_firstName: firstName,
            contact_lastName: lastName,
            contact_nickname: nickname,
            contact_campus: '',
            year_id: defaultYear,
            contact_phone: defaultPhone.value,
            contact_phoneId: defaultPhone.id,
            contact_email: defaultEmail.value,
            contact_emailId: defaultEmail.id,
            contact_notes: note
        };
        $.each(AD.Models.Contact.steps, function(stepName, stepFieldName) {
            baseAttrs[stepFieldName] = null;
        });
        var mergedAttrs = $.extend(baseAttrs, attrs);
        mergedAttrs.year_label = AD.Models.Year.cache.getById(mergedAttrs.year_id).year_label;
        return new AD.Models.Contact(mergedAttrs);
    },
    
    fields: [
        {name: 'firstName', type: 'text'},
        {name: 'lastName', type: 'text'},
        {name: 'campus', type: 'choice'},
        {name: 'year', type: 'choice', field: 'year_label'},
        {name: 'phone', type: 'choice/text', keyboardType: Ti.UI.KEYBOARD_PHONE_PAD, autocapitalization: Ti.UI.TEXT_AUTOCAPITALIZATION_NONE},
        {name: 'email', type: 'choice/text', keyboardType: Ti.UI.KEYBOARD_EMAIL, autocapitalization: Ti.UI.TEXT_AUTOCAPITALIZATION_NONE},
        {name: 'notes', type: 'text', multiline: true}
    ],
    
    years: AD.Models.Year.cache.getArray().map(function(model) { return model.year_label; }),
    actions: [{
        title: 'save',
        callback: 'save',
        rightNavButton: true
    }, {
        callback: function() {
            if (this.operation === 'edit') {
                // Changes to contacts are automatically saved during editing
                this.save();
            }
            else {
                // Closing the window cancels the add or create operation
                this.dfd.reject();
            }
        },
        menuItem: false,
        onClose: true,
        backButton: true
    }]
}, {
    init: function(options) {
        var _this = this;
        
        this.operation = options.operation;
        var getContactDfd = $.Deferred();
        
        // This handler must be attached before the handler that calls this.initialize in $.Window
        getContactDfd.done(this.proxy(function(contactData) {
            this.inAddressBook = contactData.localContact ? true : false;
            
            // Build the fields array which is the same as the static fields array, with types expanded
            this.fields = this.constructor.fields.map(function(field) {
                // Expand the type property
                var types = field.type.split('/');
                var type = types[(this.inAddressBook || types.length === 1) ? 0 : 1];
                
                // Proxy the choice callback
                var callback = null;
                if (type === 'choice') {
                    callback = this.proxy(field.callback);
                }
                
                // Clone the field to prevent aliasing
                return $.extend({}, field, {type: type, callback: callback});
            }, this);
            
            this.contact = contactData.contact;
            this.localContact = contactData.localContact;
            this.window.title = AD.Localize(this.operation+'Contact');
            this.open();
        }));
        
        // Initialize the base $.Window object
        // Pass in deferreds to delay the execution of this.create and this.initialize until a contact is chosen
        this._super({
            tab: options.tab,
            createDfd: getContactDfd.promise(),
            initializeDfd: getContactDfd.promise(),
            createParams: {
                layout: 'vertical'
            }
        });
        
        if (this.operation === 'import') {
            // Load an existing contact from the user's address book
            var chooseContactDfd = $.Deferred();
            Titanium.Contacts.showContacts({
                canceled: chooseContactDfd.reject,
                selectedPerson: function(event) {
                    chooseContactDfd.resolve(event.person);
                }
            });
            chooseContactDfd.done(this.proxy(function(selectedContact) {
                var contactRecordId = selectedContact.recordId || selectedContact.id; // recordId on iOS and id on Android
                var existingContacts = AD.Models.Contact.cache.query({contact_recordId: contactRecordId});
                var contact = null;
                if (existingContacts.length > 0) {
                    if (existingContacts.length > 1) {
                        Ti.API.warn('Found multiple contacts with the same recordId!');
                    }
                    // A contact was chosen that already exists, so edit the contact
                    contact = existingContacts[0];
                    this.operation = 'edit';
                }
                else {
                    contact = this.constructor.createContact({contact_recordId: contactRecordId});
                }
                getContactDfd.resolve({
                    contact: contact,
                    localContact: selectedContact
                });
            })).fail(this.dfd.reject); // Cancel the add contact operation
        }
        else if (this.operation === 'edit') {
            // Load the existing contact from the address book
            var recordId = options.existingContact.contact_recordId;
            var localContact = recordId === null ? null : Ti.Contacts.getPersonByID(recordId);
            getContactDfd.resolve({
                contact: options.existingContact,
                localContact: localContact
            });
        }
        else if (this.operation === 'create') {
            // Create a contact model not tied to an address book entry
            var contact = this.constructor.createContact({contact_recordId: null});
            getContactDfd.resolve({
                contact: contact,
                localContact: null
            });
        }
    },
    
    // Create each of the form fields
    create: function() {
        var labelWidth = AD.Platform.isiPhone ? 80 : 60;
        var rowHeight = 40;
        
        var focusedTextField = null;
        var hideKeyboard = function() {
            if (focusedTextField) {
                // Unfocus the previously selected text field to hide the keyboard
                focusedTextField.blur();
                focusedTextField = null;
            }
        };

        // Scrollable container that will hold the field rows on non-iPhone platforms
        var table = Ti.UI.createScrollView({
            top: 0,
            left: 0,
            width: AD.UI.screenWidth,
            height: Ti.UI.FILL,
            layout: 'vertical',
            scrollType: 'vertical',
            contentHeight: 'auto',
            showVerticalScrollIndicator: true
        });
        
        // Create the form fields
        // On iPhone, attempt to mimic the built-in Contacts app

        // Create each of the field views
        var rows = [];
        this.fields.forEach(function(field, index) {
            // Create the field row container, a table view row on iPhone and a generic view on other platforms
            var fieldRow = AD.Platform.isiPhone ? Ti.UI.createTableViewRow({}) : Ti.UI.createView({
                left: AD.UI.padding,
                right: 0,
                top: 0
            });
            fieldRow.height = rowHeight;
            fieldRow.index = index;
            
            // Create the field name label
            var label = Ti.UI.createLabel({
                left: 0,
                width: labelWidth,
                height: Ti.UI.SIZE,
                text: AD.Localize(field.name)
            });
            fieldRow.add(label);
            if (AD.Platform.isiPhone) {
                label.applyProperties({
                    text: label.text.toLowerCase(),
                    textAlign: 'right',
                    color: AD.UI.systemBlueColor,
                    font: {fontSize: 15, fontWeight: 'bold'} // medium-small bold
                });
            }
            
            var fieldValue = this.contact.attr(field.field);
            var fieldView = null;
            if (field.type === 'choice') {
                // Create the value label
                if (AD.Platform.isiPhone) {
                    fieldView = Ti.UI.createLabel({
                        left: labelWidth + AD.UI.padding,
                        width: Ti.UI.FILL,
                        height: Ti.UI.FILL,
                        text: fieldValue
                    });
                }
                else {
                    fieldView = Ti.UI.createButton({
                        left: labelWidth + AD.UI.padding,
                        right: AD.UI.padding,
                        center: { y: rowHeight / 2 },
                        height: AD.UI.buttonHeight,
                        title: fieldValue || AD.Localize('unspecified')
                    });
                    // When a choice row is clicked, call the callback that will presumably allow the user to choose a value
                    fieldView.addEventListener('click', field.callback);
                }
            }
            else if (field.type === 'text') {
                if (field.multiline === true) {
                    fieldView = Ti.UI.createTextArea({
                        left: labelWidth + AD.UI.padding,
                        right: AD.UI.padding,
                        height: Ti.UI.FILL,
                        font: AD.UI.Fonts.small,
                        suppressReturn: false
                    });
                    // Make the row taller to accommodate the text area
                    fieldRow.height *= 3;
                }
                else {
                    fieldView = Ti.UI.createTextField({
                        left: labelWidth + AD.UI.padding,
                        right: AD.UI.padding,
                        center: { y: rowHeight / 2 },
                        height: AD.UI.textFieldHeight
                    });
                }
                
                fieldView.value = fieldValue;
                
                if (field.keyboardType) {
                    fieldView.keyboardType = field.keyboardType;
                }
                if (field.autocapitalization) {
                    fieldView.autocapitalization = field.autocapitalization;
                }
            }
            
            fieldView.addEventListener('focus', function() {
                // Keep track of which text field (or text area) is currently selected
                focusedTextField = fieldView;
            });
            
            // Add the field to the row
            fieldRow.add(this.record(field.labelId, fieldView));
            rows.push(fieldRow);
            
            if (!AD.Platform.isiPhone) {
                table.add(fieldRow);
            }
        }, this);
        
        // On iPhone, hideKeyboard does not work when called from the window click
        // handler, so workaround by calling hideKeybaord from the table click handler
        if (AD.Platform.isiPhone) {
            // Create the fields table that holds the year, phone number, and email address fields
            var iPhoneTable = this.add(Ti.UI.createTableView({
                data: rows,
                style: Ti.UI.iPhone.TableViewStyle.GROUPED
            }));
            iPhoneTable.addEventListener('click', this.proxy(function(event) {
                hideKeyboard();
                
                var field = this.fields[event.row.index];
                if (field.type === 'choice') {
                    // When a choice row is clicked, call the callback that will presumably allow the user to choose a value
                    field.callback();
                }
            }));
        }
        else {
            this.add(table);
            
            // Click anywhere on the window to hide the keyboard
            this.window.addEventListener('click', function(event) {
                hideKeyboard();
            });
            
            // Create the save button on the screen
            var saveButton = Ti.UI.createButton({
                left: AD.UI.padding,
                top: AD.UI.padding,
                width: AD.UI.useableScreenWidth,
                height: AD.UI.buttonHeight * 1.5,
                titleid: 'save'
            });
            table.add(saveButton);
            saveButton.addEventListener('click', this.proxy('save'));
        }
    },
    
    // Set the initial contents of the form fields
    initialize: function() {
        var localContact = this.localContact;
        this.phoneNumbers = localContact && AD.UI.ChooseOptionWindow.multivalueToOptionsArray(localContact.getPhone());
        this.emailAddresses = localContact && AD.UI.ChooseOptionWindow.multivalueToOptionsArray(localContact.getEmail());
    },
    
    // Handlers for allowing the user to change the contact's campus, year, phone number, and e-mail address
    changeCampus: function() {
        // Allow the user to set the contact's campus
        var campuses = AD.PropertyStore.get('campuses');
        var $winChooseCampus = new AD.UI.ChooseOptionWindow({
            tab: this.tab,
            groupName: 'campus',
            initial: campuses.indexOf(this.contact.contact_campus),
            options: campuses,
            editable: true,
            onOptionsUpdate: function(campusesNew) {
                campuses = campusesNew;
                AD.PropertyStore.set('campuses', campusesNew);
            }
        });
        $winChooseCampus.getDeferred().done(this.proxy(function(campusName) {
            // A campus was chosen
            this.contact.attr('contact_campus', campusName.label);
            var campusLabel = this.getChild('campusLabel');
            campusLabel.text = campusLabel.title = campusName.label;
        }));
    },
    changeYear: function() {
        // Allow the user to choose the year of this contact
        var $winChooseYear = new AD.UI.ChooseOptionWindow({
            tab: this.tab,
            groupName: 'year',
            initial: this.contact.year_id - 1,
            options: this.constructor.years
        });
        $winChooseYear.getDeferred().done(this.proxy(function(yearData) {
            // A year was chosen
            this.contact.attr('year_id', yearData.index + 1);
            this.contact.attr('year_label', yearData.label);
            var yearLabel = this.getChild('yearLabel');
            yearLabel.text = yearLabel.title = yearData.label;
        }));
    },
    changePhone: function() {
        // Allow the user to choose the phone number to associate with this contact
        var $winChoosePhone = new AD.UI.ChooseOptionWindow({
            tab: this.tab,
            groupName: 'phone',
            initial: this.contact.contact_phoneId,
            options: this.phoneNumbers
        });
        $winChoosePhone.getDeferred().done(this.proxy(function(phoneNumber) {
            // A phone number was chosen
            this.contact.attr('contact_phone', phoneNumber.value);
            this.contact.attr('contact_phoneId', phoneNumber.id);
            var phoneLabel = this.getChild('phoneLabel');
            phoneLabel.text = phoneLabel.title = phoneNumber.value;
        }));
    },
    changeEmail: function() {
        // Allow the user to choose the email address to associate with this contact
        var $winChooseEmail = new AD.UI.ChooseOptionWindow({
            tab: this.tab,
            groupName: 'email',
            initial: this.contact.contact_emailId,
            options: this.emailAddresses
        });
        $winChooseEmail.getDeferred().done(this.proxy(function(emailAddress) {
            // An email address was chosen
            this.contact.attr('contact_email', emailAddress.value);
            this.contact.attr('contact_emailId', emailAddress.id);
            var emailLabel = this.getChild('emailLabel');
            emailLabel.text = emailLabel.title = emailAddress.value;
        }));
    },
    
    // Update the contact model and close the window
    save: function() {
        // Read the values of the text fields
        this.fields.forEach(function(field) {
            if (field.type === 'text') {
                this.contact.attr(field.field, this.children[field.labelId].value);
            }
        }, this);
        this.dfd.resolve(this.contact);
        if (this.options.autoSave !== false) {
            // Create/update the contact's record in the database unless
            // explicitly prevented by the autoSave option being set to false
            this.contact.save();
        }
    }
});
