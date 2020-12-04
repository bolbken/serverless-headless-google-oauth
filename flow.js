const puppeteer = require('puppeteer-core')
const { getChrome } = require('./chrome-script')

class OAuthFlowBrowser {
  constructor(email, password) {
    this.email = email
    this.password = password
    this.authCode = null
    this.chrome = null
    this.browser = null
  }

  async initialize() {
    this.chrome = await getChrome()
    this.browser = await puppeteer.connect({
      browserWSEndpoint: this.chrome.endpoint,
    })
  }

  async beginFlow(authURL) {
    const page = await this.browser.newPage()
    await page.goto(authURL, { waitUntil: 'networkidle0' })
    return page
  }

  async enterEmail(page) {
    await page.waitFor(300)
    await page.keyboard.press('Enter')
    return page
  }

  async enterPassword(page) {
    const passwordInput = 'input[type="password"]'
    await page.waitFor(1500)
    await page.type(passwordInput, this.password)
    await page.keyboard.press('Enter')
    await page.waitForNavigation({ waitUntil: 'networkidle0' })
    return page
  }

  async submitAllow(page) {
    const allowButton = '#submit_approve_access'
    await page.click(allowButton)
    return page
  }

  async runFlow(authURL) {
    let page
    try {
      await this.initialize()
      page = await this.beginFlow(authURL)
      page = await this.enterEmail(page)
      page = await this.enterPassword(page)
      await this.submitAllow(page)
    } catch (err) {
      this.browser.close()
      throw err
    }
  }
}

module.exports = OAuthFlowBrowser
