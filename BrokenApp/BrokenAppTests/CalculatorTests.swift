import Testing
@testable import BrokenApp

struct CalculatorTests {
    let calculator = Calculator()

    @Test func testAdd() {
        #expect(calculator.add(2, 3) == 5)
        #expect(calculator.add(-1, 1) == 0)
        #expect(calculator.add(0, 0) == 0)
    }

    @Test func testSubtract() {
        #expect(calculator.subtract(5, 3) == 2)
        #expect(calculator.subtract(1, 1) == 0)
        #expect(calculator.subtract(0, 5) == -5)
    }

    @Test func testMultiply() {
        #expect(calculator.multiply(3, 4) == 12)
        #expect(calculator.multiply(-2, 3) == -6)
        #expect(calculator.multiply(0, 100) == 0)
    }

    @Test func testDivide() {
        #expect(calculator.divide(10, 2) == 5.0)
        #expect(calculator.divide(7, 2) == 3.5)
        #expect(calculator.divide(10, 0) == nil)
    }

    @Test func testFactorial() {
        #expect(calculator.factorial(0) == 1)
        #expect(calculator.factorial(1) == 1)
        #expect(calculator.factorial(5) == 120)
        #expect(calculator.factorial(-1) == -1)
    }
}
