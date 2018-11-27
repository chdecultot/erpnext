frappe.provide("erpnext.accounts");

frappe.pages['bank-reconciliation'].on_page_load = function(wrapper) {
	new erpnext.accounts.bankReconciliation(wrapper);	
}

erpnext.accounts.bankReconciliation = class BankReconciliation {
	constructor(wrapper) {
		this.page = frappe.ui.make_app_page({
			parent: wrapper,
			title: 'Bank Reconciliation',
			single_column: true
		});
		this.parent = wrapper;
		this.page = this.parent.page;

		this.make();
		this.add_plaid_btn();
	}

	make() {
		const me = this;

		me.$main_section = $(`<div class="reconciliation page-main-content"></div>`).appendTo(me.page.main);

		me.page.add_field({
			fieldtype: 'Link',
			label: __('Bank Account'),
			fieldname: 'bank_account',
			options: "Bank Account",
			onchange: function() {
				if (this.value) {
					me.bank_account = this.value;
					me.add_actions();
				} else {
					me.bank_account = null;
					me.page.hide_actions_menu();
				}
			}
		})
	}

	add_plaid_btn() {
		const me = this;
		frappe.db.get_value("Plaid Settings", "Plaid Settings", "enabled", (r) => {
			if (r.enabled == "1") {
				me.parent.page.add_inner_button(__('Link a new bank account'), function() {
					new erpnext.accounts.plaidLink(this)
				})
			}
		})
	}

	add_actions() {
		const me = this;

		me.page.show_actions_menu()

		me.page.add_action_item(__("Upload a statement"), function() {
			me.clear_page_content();
			new erpnext.accounts.bankTransactionUpload(me);
		}, true)
		me.page.add_action_item(__("Synchronize this account"), function() {
			me.clear_page_content();
			new erpnext.accounts.bankTransactionSync(me);
		}, true)
		me.page.add_action_item(__("Reconcile this account"), function() {
			me.clear_page_content();
			me.make_reconciliation_tool();
		}, true)
	}

	clear_page_content() {
		const me = this;
		$(me.page.body).find('.frappe-list').remove();
		me.$main_section.empty();
	}

	make_reconciliation_tool() {
		const me = this;
		console.log(me)
		frappe.model.with_doctype("Bank Transaction", () => {
			new erpnext.accounts.ReconciliationTool({
				parent: me.parent,
				doctype: "Bank Transaction"
			});
		})
	}
}


erpnext.accounts.bankTransactionUpload = class bankTransactionUpload {
	constructor(parent) {
		this.parent = parent;
		this.data = [];

		const assets = [
			"/assets/frappe/css/frappe-datatable.css",
			"/assets/frappe/js/lib/clusterize.min.js",
			"/assets/frappe/js/lib/Sortable.min.js",
			"/assets/frappe/js/lib/frappe-datatable.js"
		];

		frappe.require(assets, () => {
			this.make();
		});
	}

	make() {
		const me = this;
		frappe.upload.make({
			args: {
				method: 'erpnext.accounts.doctype.bank_transaction.bank_transaction_upload.upload_bank_statement',
				allow_multiple: 0
			},
			no_socketio: true,
			sample_url: "e.g. http://example.com/somefile.csv",
			callback: function(attachment, r) {
				if (!r.exc && r.message) {
					me.data = r.message;
					me.setup_transactions_dom();
					me.create_datatable();
					me.add_primary_action();
				}
			}
		})
	}

	setup_transactions_dom() {
		const me = this;
		me.parent.$main_section.append(`<div class="transactions-table"></div>`)
	}

	create_datatable() {
		this.datatable = new DataTable('.transactions-table', {
							columns: this.data.columns,
							data: this.data.data
						})
	}

	add_primary_action() {
		const me = this;
		me.parent.page.set_primary_action(__("Submit"), function() {
			me.add_bank_entries()
		}, null, __("Creating bank entries..."))
	}

	add_bank_entries() {
		const me = this;
		frappe.xcall('erpnext.accounts.doctype.bank_transaction.bank_transaction_upload.create_bank_entries',
			{columns: this.datatable.datamanager.columns, data: this.datatable.datamanager.data, bank_account: me.parent.bank_account}
		).then((result) => {
			let result_title = __("{0} bank transaction(s) created", [result])
			let result_msg = `
				<div class="text-center">
					<h5 class="text-muted">${result_title}</h5>
				</div>`
			me.parent.page.clear_primary_action();
			me.parent.$main_section.empty();
			me.parent.$main_section.append(result_msg);
			frappe.show_alert({message:__("All bank transactions have been created"), indicator:'green'});
		})
	}
}

erpnext.accounts.bankTransactionSync = class bankTransactionSync {
	constructor(parent) {
		this.parent = parent;
		this.data = [];

		this.init_config()
	}

	init_config() {
		const me = this;
		frappe.xcall('erpnext.erpnext_integrations.doctype.plaid_settings.plaid_settings.plaid_configuration')
		.then(result => {
			me.plaid_env = result.plaid_env;
			me.plaid_public_key = result.plaid_public_key;
			me.client_name = result.client_name;
			me.sync_transactions()
		})
	}

	sync_transactions() {
		const me = this;
		frappe.db.get_value("Bank Account", me.parent.bank_account, "bank", (v) => {
			frappe.xcall('erpnext.erpnext_integrations.doctype.plaid_settings.plaid_settings.sync_transactions', {
				bank: v['bank'],
				bank_account: me.parent.bank_account,
				freeze: true
			})
			.then((result) => {
				console.log(result)
				let result_title = (result.length > 0) ? __("{0} bank transaction(s) created", [result.length]) : __("This bank account is already synchronized")
				let result_msg = `
					<div class="text-center">
						<h5 class="text-muted">${result_title}</h5>
					</div>`
				this.parent.$main_section.append(result_msg)
				frappe.show_alert({message:__("Bank account '{0}' has been synchronized", [me.parent.bank_account]), indicator:'green'});
			})
		})
	}
}

erpnext.accounts.plaidLink = class plaidLink {
	constructor(parent) {
		this.parent = parent;
		this.product = ["transactions", "auth"];
		this.plaidUrl = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
		this.init_config();
	}

	init_config() {
		const me = this;
		frappe.xcall('erpnext.erpnext_integrations.doctype.plaid_settings.plaid_settings.plaid_configuration')
		.then(result => {
			if (result !== "disabled") {
				me.plaid_env = result.plaid_env;
				me.plaid_public_key = result.plaid_public_key;
				me.client_name = result.client_name;
				me.init_plaid()
			}
		})
	}

	init_plaid() {
		const me = this;
		me.loadScript(me.plaidUrl)
			.then(() => {
				me.onScriptLoaded(me);
			})
			.then(() => {
				if (me.linkHandler) {
					me.linkHandler.open();
				}
			})
			.catch((error) => {
				me.onScriptError(error)
			})
	}

	loadScript(src) {
		return new Promise(function (resolve, reject) {
			if (document.querySelector('script[src="' + src + '"]')) {
				resolve()
				return
			}
			const el = document.createElement('script')
			el.type = 'text/javascript'
			el.async = true
			el.src = src
			el.addEventListener('load', resolve)
			el.addEventListener('error', reject)
			el.addEventListener('abort', reject)
			document.head.appendChild(el)
		})
	}

	onScriptLoaded(me) {
		me.linkHandler = window.Plaid.create({
			clientName: me.client_name,
			env: me.plaid_env,
			key: me.plaid_public_key,
			onSuccess: me.plaid_success,
			product: me.product
		})
	}

	onScriptError(error) {
		console.error('There was an issue loading the link-initialize.js script');
		console.log(error);
	}

	plaid_success(token, response) {
		const me = this;

		frappe.prompt({
			fieldtype:"Link", 
			options: "Company",
			label:__("Company"),
			fieldname:"company",
			reqd:1
		}, (data) => {
			me.company = data.company;
			frappe.xcall('erpnext.erpnext_integrations.doctype.plaid_settings.plaid_settings.add_institution', {token: token, response: response})
			.then((result) => {
				frappe.xcall('erpnext.erpnext_integrations.doctype.plaid_settings.plaid_settings.add_bank_accounts', {response: response,
					bank: result, company: me.company})
			})
			.then((result) => {
				console.log(result)
				frappe.show_alert({message:__("Bank accounts added"), indicator:'green'});
			})
		}, __("Select a company"), __("Continue"));
	}
}


erpnext.accounts.ReconciliationTool = class ReconciliationTool extends frappe.views.BaseList {
	constructor(opts) {
		super(opts);
		this.show();
	}

	setup_defaults() {
		super.setup_defaults();

		this.doctype = 'Bank Transaction';
		this.fields = ['date', 'description', 'debit', 'credit', 'currency']

	}

	setup_view() {
		this.render_header();
	}

	setup_side_bar() {
		//
	}

	make_standard_filters() {
		//
	}

	freeze() {
		this.$result.find('.list-count').html(`<span>${__('Refreshing')}...</span>`);
	}

	get_args() {
		const args = super.get_args();

		return Object.assign({}, args, {
			...args.filters.push(["Bank Transaction", "docstatus", "=", 1],
				["Bank Transaction", "payment_entry", "=", ""])
		});
		
	}

	update_data(r) {
		let data = r.message || [];

		if (this.start === 0) {
			this.data = data;
		} else {
			this.data = this.data.concat(data);
		}
	}

	render() {
		const me = this;
		this.$result.find('.list-row-container').remove();
		$('[data-fieldname="name"]').remove();
		me.data.map((value) => {
			const row = $('<div class="list-row-container">').data("data", value).appendTo(me.$result).get(0);
			new erpnext.accounts.ReconciliationRow(row, value);
		})

		me.parent.page.hide_menu()
	}

	render_header() {
		const me = this;
		if ($(this.wrapper).find('.transaction-header').length === 0) {
			me.$result.append(frappe.render_template("bank_transaction_header"));
		}
	}
}

erpnext.accounts.ReconciliationRow = class ReconciliationRow {
	constructor(row, data) {
		this.data = data;
		this.row = row;
		this.make();
		this.bind_events();
	}

	make() {
		$(this.row).append(frappe.render_template("bank_transaction_row", this.data))
	}

	bind_events() {
		const me = this;
		$(me.row).on('click', '.clickable-section', function() {
			me.bank_entry = $(this).attr("data-name");
			me.show_dialog($(this).attr("data-name"));
		})

		$(me.row).on('click', '.new-payment', function() {
			me.bank_entry = $(this).attr("data-name");
			me.new_payment();
		})

		$(me.row).on('click', '.new-invoice', function() {
			me.bank_entry = $(this).attr("data-name");
			me.new_invoice();
		})
	}

	new_payment() {
		const me = this;
		const paid_amount = me.data.credit > 0 ? me.data.credit : me.data.debit;
		const payment_type = me.data.credit > 0 ? "Receive": "Pay";
		const party_type = me.data.credit > 0 ? "Customer": "Supplier";

		frappe.new_doc("Payment Entry", {"payment_type": payment_type, "paid_amount": paid_amount,
			"party_type": party_type, "paid_from": me.data.bank_account})
	}

	new_invoice() {
		const me = this;
		const invoice_type = me.data.credit > 0 ? "Sales Invoice" : "Purchase Invoice";

		frappe.new_doc(invoice_type)
	}

	show_dialog(data) {
		const me = this;
		frappe.xcall('erpnext.accounts.page.bank_reconciliation.bank_reconciliation.get_linked_payments', 
			{bank_transaction: data}
		)
		.then((result) => {
			me.make_dialog(result)
		})
	}

	make_dialog(data) {
		const me = this;
		const fields = [
			{
				fieldtype: 'Section Break',
				fieldname: 'section_break_1',
				label: __('Automatic Reconciliation')
			},
			{
				fieldtype: 'HTML',
				fieldname: 'payment_proposals'
			},
			{
				fieldtype: 'Section Break',
				fieldname: 'section_break_2',
				label: __('Search for a payment')
			},
			{
				fieldtype: 'Link',
				fieldname: 'payment_entry',
				options: 'Payment Entry',
				label: 'Payment Entry'
			},
			{
				fieldtype: 'HTML',
				fieldname: 'payment_details'
			},
		];
	
		me.dialog = new frappe.ui.Dialog({
			title: __("Choose a corresponding payment"),
			fields: fields
		});

		const proposals_wrapper = me.dialog.fields_dict.payment_proposals.$wrapper;
		if (data.length > 0) {
			data.map(value => {
				proposals_wrapper.append(frappe.render_template("linked_payment_row", value))
			})
		} else {
			const empty_data_msg = __("ERPNext could not find any matching payment entry")
			proposals_wrapper.append(`<div class="text-center"><h5 class="text-muted">${empty_data_msg}</h5></div>`)
		}

		$(me.dialog.body).on('click', '.reconciliation-btn', (e) => {
			const payment_entry = $(e.target).attr('data-name');
			frappe.xcall('erpnext.accounts.page.bank_reconciliation.bank_reconciliation.reconcile',
				{bank_transaction: me.bank_entry, payment_entry: payment_entry})
			.then((result) => console.log(result))
		})

		$(me.dialog.body).on('blur', '.input-with-feedback', (e) => {
			e.preventDefault();
			me.dialog.fields_dict['payment_details'].$wrapper.empty();
			frappe.db.get_doc("Payment Entry", e.target.value)
			.then(doc => {
				const details_wrapper = me.dialog.fields_dict.payment_details.$wrapper;
				details_wrapper.append(frappe.render_template("linked_payment_row", doc));
			})
				
		});
		me.dialog.show();
	}
}